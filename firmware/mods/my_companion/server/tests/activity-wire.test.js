import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import WebSocket, { WebSocketServer } from 'ws'
import { ActivityInput } from '../../ai/activity-input.js'
import { encodeAudio } from '../../ai/realtime-protocol.js'
import { RealtimeSession } from '../../ai/realtime-session.js'
import { MockAudioInput } from '../../simulator/mock-audio-input.js'
import { MockAudioOutput } from '../../simulator/mock-audio-output.js'
import { createDeviceRuntime } from '../node-runtime.js'
import { Phase46Observer } from '../phase46-observer.js'
import { ApiYiRealtimeProvider } from '../providers/apiyi/apiyi-realtime-provider.js'
import { modelConfig } from '../providers/apiyi/model-config.js'
import { AIServer } from '../server.js'

// Offline upstream fixture over real local WS sockets. No external API calls.
test('PCM activity stops playback before delayed Provider ACK; streaming input, fresh reply, late-packet isolation and cleanup remain intact', async () => {
  const vendor = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(vendor, 'listening')
  const jobs = new Set()
  let chunks = 0
  let acknowledged = false
  let cancelSeen = false
  const later = (fn, ms) => {
    const id = setTimeout(() => {
      jobs.delete(id)
      fn()
    }, ms)
    jobs.add(id)
  }
  vendor.on('connection', (socket) => {
    const send = (event) => socket.send(JSON.stringify(event))
    send({ type: 'session.created' })
    socket.on('message', (raw) => {
      const e = JSON.parse(raw.toString())
      if (e.type === 'session.update') send({ type: 'session.updated' })
      if (e.type === 'input_audio_buffer.append') {
        chunks++
        if (chunks === 4) {
          send({ type: 'input_audio_buffer.speech_stopped', item_id: 'i1' })
          send({ type: 'response.created', response: { id: 'r1' } })
          for (let n = 0; n < 8; n++)
            send({ type: 'response.audio.delta', response_id: 'r1', delta: Buffer.alloc(15360).toString('base64') })
        }
      }
      if (e.type === 'response.cancel') {
        cancelSeen = true
        later(() => {
          acknowledged = true
          send({ type: 'response.output_item.done', response_id: 'r1', item: { type: 'message' } })
          send({ type: 'response.audio.delta', response_id: 'r1', delta: Buffer.alloc(960).toString('base64') })
          send({ type: 'input_audio_buffer.speech_stopped', item_id: 'i2' })
          send({ type: 'response.created', response: { id: 'r2' } })
          send({ type: 'response.audio.delta', response_id: 'r2', delta: Buffer.alloc(2880).toString('base64') })
          send({ type: 'response.done', response: { id: 'r2', status: 'completed', usage: { output_tokens: 2 } } })
        }, 350)
      }
    })
  })
  const token = 'd'.repeat(32)
  const server = await new AIServer({
    port: 0,
    devices: [{ deviceId: 'robot-001', tokens: [token] }],
    providerFactory: () =>
      new ApiYiRealtimeProvider({
        env: { APIYI_API_KEY: 'OFFLINE_ONLY' },
        config: modelConfig(),
        socketFactory: (_url, options) => new WebSocket(`ws://127.0.0.1:${vendor.address().port}`, options),
      }),
  }).start()
  const rawInput = new MockAudioInput()
  const output = new MockAudioOutput()
  let session
  const options = {
    getSession: () => session,
    now: () => performance.now(),
    onEvent: (event) => sim.voiceOptions.onActivity?.(event),
  }
  const input = new ActivityInput(rawInput, options)
  session = new RealtimeSession({
    options: { deviceId: 'robot-001', url: server.url, connectionTimeoutMs: 1000 },
    runtime: createDeviceRuntime(() => ({ deviceId: 'robot-001', token })),
    wifi: { isConnected: () => true, onStatusChanged: () => () => {} },
    input,
    output,
  })
  const sim = { realtime: session, audioInput: rawInput, audioOutput: output, aiServer: server, voiceOptions: {} }
  const observer = new Phase46Observer()
  observer.attach(sim)
  const wait = async (check) => {
    const end = performance.now() + 4000
    while (!check()) {
      assert(performance.now() < end)
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
  }
  try {
    session.start()
    await wait(() => session.status === 'CONNECTED')
    observer.startTrial({ requestId: session.requestId, sample: 1, mode: 'offline-barge' })
    await rawInput.utterance()
    await wait(() => session.playing)
    const stops = output.stopCount
    const pcm = new ArrayBuffer(640)
    const v = new DataView(pcm)
    for (let n = 0; n < 320; n++) v.setInt16(n * 2, Math.sin((n * Math.PI) / 8) * 5000, true)
    rawInput.onChunk(pcm)
    await new Promise((resolve) => setTimeout(resolve, 20))
    rawInput.onChunk(pcm)
    assert.equal(acknowledged, false)
    assert.equal(session.responseTurn, null)
    assert.equal(output.stopCount, stops + 1)
    assert.equal(session.buffer.bytes, 0)
    assert(rawInput.onChunk, 'capture must remain running while ACK is pending')
    await wait(() => cancelSeen)
    const peer = [...server.sessions.values()][0]
    peer.socket.send(encodeAudio(2, 1, 999, new ArrayBuffer(960), 1920))
    await wait(() => acknowledged && session.phase === 'IDLE')
    assert(chunks >= 6)
    const old = [...observer.turns.values()].find((t) => t.turnId === 1)
    const fresh = [...observer.turns.values()].find((t) => t.turnId === 2)
    assert(old.stopInvokedAt - old.detectedAt <= 50)
    assert(old.bufferClearedAt >= old.stopInvokedAt)
    assert(old.cancelAcknowledgedAt > old.stopInvokedAt)
    assert.equal(old.remainingBufferBytes, 0)
    assert.equal(old.oldLeakBytes, 0)
    assert.equal(old.lateDroppedBytes, 960)
    assert.equal(fresh.completedBytes, 2880)
    assert(fresh.firstAudioAt < fresh.playbackCompletedAt)
  } finally {
    session.dispose()
    await server.close()
    for (const id of jobs) clearTimeout(id)
    for (const socket of vendor.clients) socket.terminate()
    await new Promise((resolve) => vendor.close(resolve))
  }
  const result = observer.finish()
  assert.deepEqual(result.resources.providerTimers, [0])
  assert.equal(result.resources.sessionTimers, 0)
  assert.equal(result.resources.bufferBytes, 0)
  assert(result.resources.inputHandlerReleased && result.resources.outputTimerReleased)
})
