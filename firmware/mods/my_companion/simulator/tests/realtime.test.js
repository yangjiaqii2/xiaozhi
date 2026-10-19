import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeAudio } from '../../ai/realtime-protocol.js'
import { RealtimeSimulator } from '../realtime-simulator.js'

async function setup(t, options = {}) {
  const logs = []
  const sim = new RealtimeSimulator({
    port: 0,
    latencyMs: 0,
    debug: options.debug ?? false,
    write: (line) => logs.push(line),
    realtimeServer: { firstAudioDelayMs: 20, outputIntervalMs: 30, ...options.server },
    realtime: { connectionTimeoutMs: 150, responseTimeoutMs: 1000, ...options.realtime },
    audioOutput: options.audioOutput,
  })
  await sim.start()
  t.after(() => sim.close())
  assert.equal((await sim.connectRealtime()).ok, true)
  return { sim, rt: sim.realtime, logs }
}

test('real loopback WS handshake, idempotent start and three streaming turns', async (t) => {
  const { sim, rt, logs } = await setup(t)
  rt.start()
  rt.start()
  assert.equal(rt.status, 'CONNECTED')
  assert.equal(sim.realtimeServer.stats.connections, 1)
  assert(logs.includes('[realtime] status=CONNECTING'))
  assert(logs.includes('[realtime] status=CONNECTED'))
  for (let turn = 1; turn <= 3; turn++) {
    assert.equal((await sim.voice()).ok, true)
    assert.equal(rt.phase, 'THINKING')
    await sim.waitFor(() => rt.phase === 'IDLE')
    assert.equal(rt.metrics.audioChunksSent, turn * 4)
    assert.equal(rt.metrics.audioChunksReceived, turn * 3)
    assert.equal(rt.buffer.bytes, 0)
  }
  assert.equal(rt.metrics.audioBytesSent, 7680)
  assert.equal(rt.metrics.audioBytesReceived, 8640)
  assert.equal(sim.realtimeServer.stats.completedTurns, 3)
  assert.equal(sim.audioOutput.playedChunks, 9)
  assert.equal(rt.metrics.interruptionCount, 0)
  assert.equal(rt.metrics.reconnectCount, 0)
})

test('first valid chunk enters SPEAKING before response complete; measured 500ms TTFA', async (t) => {
  const { sim, rt } = await setup(t, { server: { firstAudioDelayMs: 500, outputIntervalMs: 150 } })
  await sim.voice()
  assert.equal(rt.phase, 'THINKING')
  await sim.waitFor(() => rt.metrics.audioChunksReceived === 1)
  assert.equal(rt.phase, 'SPEAKING')
  assert.equal(sim.realtimeServer.stats.completedTurns, 0)
  assert(rt.metrics.timeToFirstAudio >= 490, JSON.stringify(rt.metrics))
  assert(rt.metrics.timeToFirstAudio < 1500, JSON.stringify(rt.metrics))
  await sim.waitFor(() => sim.audioOutput.playedChunks >= 1)
  assert.equal(sim.realtimeServer.stats.completedTurns, 0)
  await sim.waitFor(() => rt.phase === 'IDLE')
  console.log(`[measured] ${JSON.stringify(rt.metrics)}`)
})

test('barge-in stops output immediately, empties buffer, sends cancel/clear, ignores stale PCM', async (t) => {
  const { sim, rt, logs } = await setup(t, {
    server: { outputChunks: 8, outputIntervalMs: 20 },
    audioOutput: { playbackMs: 100 },
  })
  await sim.voice()
  await sim.waitFor(() => rt.phase === 'SPEAKING' && sim.audioOutput.timer !== null)
  const oldTurn = rt.responseTurn.id
  assert.equal(rt.interrupt(), true)
  assert.equal(rt.phase, 'LISTENING')
  assert.equal(rt.buffer.bytes, 0)
  assert.equal(sim.audioOutput.timer, null)
  assert(logs.some((line) => line.includes('phase=INTERRUPTED')))
  await sim.waitFor(() => sim.realtimeServer.stats.clearEvents === 1)
  assert.equal(sim.realtimeServer.stats.cancelEvents, 1)
  const dropped = rt.metrics.droppedChunks
  rt.message(encodeAudio(2, oldTurn, 2, new ArrayBuffer(960), 1920))
  assert.equal(rt.metrics.droppedChunks, dropped + 1)
  assert.equal(rt.phase, 'LISTENING')
  assert.equal((await sim.voice()).ok, true)
  await sim.waitFor(() => rt.phase === 'IDLE')
  assert.equal(rt.metrics.interruptionCount, 1)
})

test('server activity hint interrupts while microphone continues uploading next turn', async (t) => {
  const { sim, rt } = await setup(t, { server: { outputChunks: 10 } })
  await sim.voice()
  await sim.waitFor(() => rt.phase === 'SPEAKING')
  assert.equal((await sim.voice()).ok, true)
  await sim.waitFor(() => rt.phase === 'IDLE')
  assert.equal(rt.metrics.interruptionCount, 1)
  assert.equal(sim.realtimeServer.stats.inputChunks, 8)
  assert.equal(sim.realtimeServer.stats.cancelEvents, 1)
})

test('input is delivered chunk by chunk before utterance completes, not as a full recording', async (t) => {
  const { sim, rt } = await setup(t)
  let complete = false
  const recording = sim.audioInput.utterance({ intervalMs: 50 }).then(() => {
    complete = true
  })
  await sim.waitFor(() => sim.realtimeServer.stats.inputChunks === 1)
  assert.equal(complete, false)
  assert.equal(rt.metrics.audioChunksSent, 1)
  await recording
  rt.commitInput()
  await sim.waitFor(() => rt.phase === 'IDLE')
  assert.equal(sim.realtimeServer.stats.inputChunks, 4)
})

test('speech hint also cancels queued playback after server has finished generation', async (t) => {
  const { sim, rt } = await setup(t, { audioOutput: { playbackMs: 200 } })
  await sim.voice()
  await sim.waitFor(() => rt.responseTurn?.done === true)
  assert.equal(rt.phase, 'SPEAKING')
  const next = sim.voice()
  await sim.waitFor(() => rt.metrics.interruptionCount === 1)
  assert.equal(sim.audioOutput.timer, null)
  assert.equal(rt.phase, 'LISTENING')
  await next
  await sim.waitFor(() => rt.phase === 'IDLE')
})

test('Wi-Fi loss clears audio and reconnects into a fresh session', async (t) => {
  const { sim, rt, logs } = await setup(t)
  const previous = rt.sessionId
  sim.network.setAvailable(false)
  await sim.waitFor(() => rt.status === 'RECONNECTING')
  assert.equal(rt.phase, 'IDLE')
  assert(logs.includes('[realtime] status=DISCONNECTED'))
  assert(logs.includes('[realtime] status=RECONNECTING'))
  assert.equal(rt.buffer.bytes, 0)
  sim.network.setAvailable(true)
  await sim.waitFor(() => rt.status === 'CONNECTED')
  assert.notEqual(rt.sessionId, previous)
  assert(rt.metrics.reconnectCount >= 1)
  assert.equal((await sim.voice()).ok, true)
  await sim.waitFor(() => rt.phase === 'IDLE')
})

test('server closes persistent connection; session auto reconnects once', async (t) => {
  const { sim, rt } = await setup(t)
  const previous = rt.sessionId
  sim.realtimeServer.disconnectPeers()
  await sim.waitFor(() => rt.status === 'CONNECTED' && rt.sessionId !== previous)
  assert.equal(rt.metrics.reconnectCount, 1)
})

test('invalid JSON event does not crash Companion or prevent valid audio', async (t) => {
  const { sim, rt } = await setup(t, { server: { scenario: 'invalid-message' } })
  await sim.voice()
  await sim.waitFor(() => rt.phase === 'IDLE')
  assert.equal(rt.metrics.protocolErrors, 1)
  assert.equal(rt.metrics.audioChunksReceived, 3)
  assert.equal(rt.status, 'CONNECTED')
})

for (const scenario of ['large-chunk', 'buffer-overflow']) {
  test(`${scenario} fails closed, bounded memory, successful reconnect`, async (t) => {
    const { sim, rt } = await setup(t, { server: { scenario }, audioOutput: { playbackMs: 200 } })
    const previous = rt.sessionId
    await sim.voice()
    await sim.waitFor(() => rt.metrics.reconnectCount >= 1)
    assert(rt.buffer.bytes <= rt.options.buffer.maxBytes)
    assert.equal(rt.phase, 'IDLE')
    await sim.waitFor(() => rt.status === 'CONNECTED' && rt.sessionId !== previous)
  })
}

test('sequence hole cancels response, duplicate/stale chunks are dropped', async (t) => {
  const { sim, rt } = await setup(t, { server: { scenario: 'sequence-error' } })
  await sim.voice()
  await sim.waitFor(() => rt.phase === 'SPEAKING')
  const turnId = rt.responseTurn.id
  rt.message(encodeAudio(2, turnId, 1, new ArrayBuffer(960), 1920))
  await sim.waitFor(() => rt.metrics.interruptionCount === 1)
  assert(rt.metrics.droppedChunks >= 2)
  assert.equal(rt.phase, 'LISTENING')
  assert.equal(rt.buffer.bytes, 0)
})

for (const scenario of ['unknown-emotion', 'unknown-action']) {
  test(`${scenario} is safely mapped by existing controllers`, async (t) => {
    const { sim, rt, logs } = await setup(t, { server: { scenario }, debug: true })
    await sim.voice()
    await sim.waitFor(() => rt.phase === 'IDLE')
    assert(logs.some((line) => line.includes(scenario === 'unknown-emotion' ? 'fallback NEUTRAL' : 'ignored')))
    assert.equal(rt.metrics.audioChunksReceived, 3)
    assert.equal(rt.metrics.reconnectCount, 0)
  })
}

test('response stall times out, playback stops and reconnect begins', async (t) => {
  const { sim, rt } = await setup(t, { server: { scenario: 'no-output' }, realtime: { responseTimeoutMs: 50 } })
  await sim.voice()
  await sim.waitFor(() => rt.metrics.reconnectCount >= 1)
  assert.equal(rt.lastError, 'RESPONSE_TIMEOUT')
  assert.equal(rt.phase, 'IDLE')
})

test('heartbeat detects a silent peer and uses finite retry budget', async (t) => {
  const { sim, rt } = await setup(t, {
    server: { scenario: 'no-pong' },
    realtime: {
      heartbeatMs: 20,
      heartbeatTimeoutMs: 40,
      reconnect: { initialDelayMs: 5, maxDelayMs: 5, maxAttempts: 1 },
    },
  })
  await sim.waitFor(() => rt.status === 'ERROR')
  assert.equal(rt.lastError, 'HEARTBEAT_TIMEOUT')
  assert.equal(rt.metrics.reconnectCount, 1)
  assert.equal(rt.timers.size, 0)
})

test('stop/start/dispose are idempotent and release sockets, timers, buffers and audio', async (t) => {
  const { sim, rt } = await setup(t)
  await sim.voice()
  rt.stop()
  rt.stop()
  assert.equal(rt.status, 'STOPPED')
  assert.equal(rt.timers.size, 0)
  assert.equal(rt.buffer.bytes, 0)
  assert.equal(sim.audioInput.onChunk, null)
  assert.equal(sim.audioOutput.timer, null)
  assert.equal(sim.realtimeRuntime.connections.size, 0)
  rt.start()
  rt.start()
  await sim.waitFor(() => rt.status === 'CONNECTED')
  rt.dispose()
  rt.dispose()
  assert.equal(rt.timers.size, 0)
  assert.equal(rt.unsubscribe, null)
  assert.throws(() => rt.start(), /DISPOSED/)
  await sim.close()
  assert.equal(sim.realtimeServer.peers.size, 0)
  assert.equal(sim.audioInput.timers.size, 0)
})

test('session.ready timeout exhausts finite reconnect budget and clears all timers', async (t) => {
  const sim = new RealtimeSimulator({
    port: 0,
    latencyMs: 0,
    debug: false,
    write() {},
    realtimeServer: { scenario: 'no-ready' },
    realtime: { connectionTimeoutMs: 30, reconnect: { initialDelayMs: 5, maxDelayMs: 5, maxAttempts: 1 } },
  })
  await sim.start()
  t.after(() => sim.close())
  assert.equal((await sim.connectRealtime()).ok, false)
  assert.equal(sim.realtime.lastError, 'CONNECTION_TIMEOUT')
  assert.equal(sim.realtime.metrics.reconnectCount, 1)
  assert.equal(sim.realtime.timers.size, 0)
})

test('outbound backpressure cancels stream instead of accumulating unbounded PCM', async (t) => {
  const { sim, rt } = await setup(t)
  rt.client.transport.send = () => {
    const error = new Error('blocked')
    error.code = 'SEND_BACKPRESSURE'
    throw error
  }
  await sim.voice()
  assert.equal(rt.lastError, 'SEND_BACKPRESSURE')
  assert.equal(rt.phase, 'IDLE')
  assert.equal(rt.buffer.bytes, 0)
  assert.equal(sim.audioInput.onChunk, null)
})

test('old session controls cannot change current emotions or response lifecycle', async (t) => {
  const { sim, rt } = await setup(t)
  await sim.voice()
  const phase = rt.phase
  rt.message(JSON.stringify({ type: 'response.done', sessionId: 'stale', turnId: rt.responseTurn.id }))
  assert.equal(rt.phase, phase)
  assert.equal(rt.responseTurn.done, false)
  const peer = [...sim.realtimeServer.peers][0]
  peer.wire.send('{')
  peer.wire.send('{')
  peer.wire.send('{')
  await sim.waitFor(() => rt.lastError === 'INVALID_MESSAGE')
  assert.equal(rt.lastError, 'INVALID_MESSAGE')
  assert.equal(rt.phase, 'IDLE')
})

test('lost speaker completion callback has its own timeout after response.done', async (t) => {
  const { sim, rt } = await setup(t, { realtime: { playbackTimeoutMs: 60 } })
  sim.audioOutput.write = () => {}
  await sim.voice()
  await sim.waitFor(() => rt.lastError === 'PLAYBACK_TIMEOUT')
  assert.equal(rt.phase, 'IDLE')
  assert.equal(rt.buffer.bytes, 0)
})

test('stop inside connection or speaking callbacks cannot restart audio or leave timers', async (t) => {
  const { sim, rt } = await setup(t)
  rt.stop()
  rt.onStatus = (status) => {
    if (status === 'CONNECTED') rt.stop()
  }
  rt.start()
  await sim.waitFor(() => rt.status === 'STOPPED')
  assert.equal(sim.audioInput.onChunk, null)
  assert.equal(rt.timers.size, 0)
  rt.onStatus = () => {}
  rt.start()
  await sim.waitFor(() => rt.status === 'CONNECTED')
  rt.onPhase = (phase) => {
    if (phase === 'SPEAKING') rt.stop()
  }
  await sim.voice()
  await sim.waitFor(() => rt.status === 'STOPPED')
  assert.equal(sim.audioOutput.timer, null)
  assert.equal(rt.buffer.bytes, 0)
  assert.equal(rt.timers.size, 0)
})

test('bounded per-turn stage timestamps use one runtime and never invent remote or acoustic measurements', async (t) => {
  const { sim, rt } = await setup(t)
  let previous
  for (let n = 1; n <= 3; n++) {
    await sim.voice()
    await sim.waitFor(() => rt.phase === 'IDLE')
    const stage = rt.lastAudioTrace
    assert.equal(stage.turnId, n)
    assert.equal(stage.sessionId, rt.sessionId)
    assert.equal(stage.requestId, rt.requestId)
    assert.equal(stage.clockDomain, 'runtime_monotonic')
    assert(stage.inputDeliveredAt <= stage.inputSentAt)
    assert(stage.inputLastSentAt <= stage.deviceFirstAudioAt)
    assert(stage.deviceFirstAudioAt <= stage.playbackStartedAt)
    assert(stage.playbackStartedAt <= stage.playbackCompletedAt)
    for (const field of [
      'inputCapturedAt',
      'serverReceivedAt',
      'providerReceivedAt',
      'providerFirstAudioAt',
      'serverSentAt',
      'acousticOutputAt',
    ])
      assert.equal(stage[field], null)
    assert.notEqual(stage, previous)
    previous = stage
  }
})
