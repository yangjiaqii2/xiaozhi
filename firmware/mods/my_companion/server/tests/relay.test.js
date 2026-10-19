import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import WebSocket from 'ws'
import { parseEvent } from '../../ai/realtime-protocol.js'
import { RealtimeSession } from '../../ai/realtime-session.js'
import { MockAudioInput } from '../../simulator/mock-audio-input.js'
import { MockAudioOutput } from '../../simulator/mock-audio-output.js'
import { createDeviceRuntime } from '../node-runtime.js'
import { RealtimeProvider } from '../provider/realtime-provider.js'
import { modelConfig } from '../providers/apiyi/model-config.js'
import { AIServer } from '../server.js'

const token = 'a'.repeat(32)
class FakeProvider extends RealtimeProvider {
  constructor(options = {}) {
    super()
    this.config = modelConfig(undefined, options.config)
    this.metrics = { interruption_latency: 0 }
    this.chunks = 0
    this.commits = 0
    this.cancels = 0
    this.timers = new Set()
    this.options = options
    this.serial = 0
  }
  async connect() {
    if (this.options.failConnect) {
      this.emit('error', { code: 'PROVIDER_NETWORK_ERROR' })
      throw new Error('offline')
    }
    this.configured = true
    this.emit('session_ready', {})
    return this
  }
  sendAudioChunk(pcm) {
    this.chunks++
    this.bytes = (this.bytes ?? 0) + pcm.length
    if (this.chunks % 4 === 1) this.emit('speech_started', {})
    if (this.config.vad !== 'manual' && this.chunks % 4 === 0) {
      this.emit('speech_stopped', {})
      this.createResponse()
    }
  }
  commitInput() {
    this.commits++
  }
  createResponse() {
    this.id = `response-${++this.serial}`
    const responseId = this.id
    this.emit('response_started', { responseId })
    this.emit('text_delta', { responseId, delta: 'A'.repeat(900) })
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (this.id !== responseId) return
      this.emit('audio_delta', { responseId, pcm: Buffer.alloc(2880) })
      this.emit('response_done', { responseId, status: 'completed', usage: { output_tokens: 3 } })
    }, 25)
    this.timers.add(timer)
  }
  async cancelResponse() {
    this.cancels++
    this.id = null
    this.emit('interrupted', { reason: 'output_item.done' })
  }
  close() {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.closed = true
  }
}

async function waitFor(condition, ms = 2000) {
  const deadline = performance.now() + ms
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('WAIT_TIMEOUT')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

async function setup(t, options = {}) {
  const providers = []
  const logs = []
  const phases = []
  const text = []
  const server = await new AIServer({
    devices: [{ deviceId: 'robot-001', tokens: [token], instructions: 'server-only' }],
    port: 0,
    retryDelayMs: 5,
    maxRetries: options.maxRetries ?? 2,
    providerFactory: (identity) => {
      assert.equal(identity.instructions, 'server-only')
      const provider = new FakeProvider({
        ...options.provider,
        failConnect: providers.length < (options.failures ?? 0),
      })
      providers.push(provider)
      return provider
    },
    log: (record) => logs.push(record),
  }).start()
  const input = new MockAudioInput()
  const output = new MockAudioOutput()
  const session = new RealtimeSession({
    options: {
      url: server.url,
      deviceId: 'robot-001',
      connectionTimeoutMs: 500,
      heartbeatMs: 50,
      heartbeatTimeoutMs: 150,
      reconnect: { initialDelayMs: 10, maxDelayMs: 20, maxAttempts: 2 },
    },
    runtime: createDeviceRuntime(() => ({ deviceId: 'robot-001', token })),
    wifi: { isConnected: () => true, onStatusChanged: () => () => {} },
    input,
    output,
    onPhase: (phase) => phases.push(phase),
    onTextDelta: (delta) => text.push(delta),
  })
  t.after(async () => {
    session.dispose()
    await server.close()
  })
  session.start()
  await waitFor(() => session.status === 'CONNECTED')
  return { server, providers, logs, phases, text, session, input, output }
}

test('unauthorized upgrade is HTTP 401 and cannot construct a Provider', async (t) => {
  let calls = 0
  const server = await new AIServer({
    port: 0,
    devices: [{ deviceId: 'robot-001', tokens: [token] }],
    providerFactory: () => {
      calls++
      assert.fail('unauthorized provider')
    },
  }).start()
  t.after(() => server.close())
  const socket = new WebSocket(server.url)
  socket.on('error', () => {})
  const [request, response] = await once(socket, 'unexpected-response')
  assert.equal(response.statusCode, 401)
  response.resume()
  request.destroy()
  socket.terminate()
  assert.equal(calls, 0)
  assert.equal(server.sessions.size, 0)
})

test('real local Server + original Session: input streaming, VAD ack, paced audio, text and three rounds', async (t) => {
  const { providers, session, input, output, phases, text } = await setup(t)
  for (let n = 1; n <= 3; n++) {
    await input.utterance()
    await waitFor(() => output.playedChunks === n * 3 && session.phase === 'IDLE')
  }
  assert.equal(providers[0].chunks, 12)
  assert.equal(providers[0].commits, 0, 'automatic VAD must never send upstream manual commit')
  assert.equal(output.playedBytes, 8640)
  assert(phases.includes('THINKING'))
  assert(phases.includes('SPEAKING'))
  assert.equal(text.join('').length, 2700)
  assert(text.every((delta) => delta.length <= 512))
  assert.equal(session.metrics.protocolErrors, 0)
})

test('bounded reconnect retries rebuild/reconfigure provider; active loss clears audio and new session succeeds', async (t) => {
  const { providers, session, input, server } = await setup(t, { failures: 2 })
  assert.equal(providers.length, 3)
  assert(providers[2].configured)
  const previous = session.sessionId
  providers[2].emit('disconnected', { code: 'PROVIDER_DISCONNECTED' })
  await waitFor(() => session.status === 'CONNECTED' && session.sessionId !== previous)
  assert.equal(providers.length, 4)
  assert(providers[3].configured)
  assert.equal(server.sessions.size, 1)
  assert.equal(session.buffer.bytes, 0)
  await input.utterance()
  await waitFor(() => session.phase === 'IDLE')
})

test('interruption clears current generation and ignores late provider audio', async (t) => {
  const { providers, session, input, output, server } = await setup(t)
  await input.utterance()
  await waitFor(() => session.phase === 'SPEAKING')
  const id = providers[0].id
  session.interrupt()
  await waitFor(() => providers[0].cancels === 1)
  const count = output.playedChunks
  providers[0].emit('audio_delta', { responseId: id, pcm: Buffer.alloc(960) })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(output.playedChunks, count)
  assert.equal(session.buffer.bytes, 0)
  assert.equal([...server.sessions.values()][0].output.bytes, 0)
})

test('device protocol extension rejects bad types and accepts normalized errors/text', () => {
  assert.equal(
    parseEvent(JSON.stringify({ type: 'error', sessionId: 's1', code: 'PROVIDER_UNAVAILABLE' }), 2048).code,
    'PROVIDER_UNAVAILABLE',
  )
  assert.throws(() => parseEvent(JSON.stringify({ type: 'error', sessionId: 's1', code: 1 }), 2048))
  assert.throws(() =>
    parseEvent(JSON.stringify({ type: 'response.text.delta', sessionId: 's1', turnId: 1, delta: {} }), 2048),
  )
})

test('explicit manual input commits once; automatic mode remains independently controlled by VAD', async (t) => {
  const { providers, session, input, output } = await setup(t, { provider: { config: { vad: 'manual' } } })
  await input.utterance()
  assert.equal(output.playedChunks, 0)
  assert.equal(providers[0].commits, 0)
  assert.equal(session.commitInput(), true)
  await waitFor(() => session.phase === 'IDLE')
  assert.equal(providers[0].commits, 1)
  assert.equal(output.playedChunks, 3)
})

test('unauthorized device transport fails permanently without allocating or retrying Provider', async (t) => {
  let calls = 0
  const server = await new AIServer({
    port: 0,
    devices: [{ deviceId: 'robot-001', tokens: [token] }],
    providerFactory: () => {
      calls++
      assert.fail('unauthorized provider')
    },
  }).start()
  const session = new RealtimeSession({
    options: { url: server.url, deviceId: 'robot-001' },
    runtime: createDeviceRuntime(() => ({ deviceId: 'robot-001', token: 'wrong' })),
    wifi: { isConnected: () => true, onStatusChanged: () => () => {} },
    input: new MockAudioInput(),
    output: new MockAudioOutput(),
  })
  t.after(async () => {
    session.dispose()
    await server.close()
  })
  session.start()
  await waitFor(() => session.status === 'ERROR')
  assert.equal(session.lastError, 'DEVICE_UNAUTHORIZED')
  assert.equal(session.metrics.reconnectCount, 0)
  assert.equal(calls, 0)
  assert.equal(session.timers.size, 0)
})

test('unrecoverable PCM capacity cancels the active generation and releases its queue', async (t) => {
  const { server, providers, input, logs } = await setup(t)
  const peer = [...server.sessions.values()][0]
  const provider = providers[0]
  provider.createResponse = () => {
    provider.emit('response_started', { responseId: 'oversized' })
    provider.emit('audio_delta', { responseId: 'oversized', pcm: Buffer.alloc(200000) })
  }
  await input.utterance()
  await waitFor(() => logs.some((record) => record.type === 'error' && record.code === 'OUTPUT_CAPACITY_EXCEEDED'))
  assert.equal(provider.cancels, 1)
  assert.equal(peer.output.bytes, 0)
  assert.equal(peer.output.timer, null)
  assert(logs.some((record) => record.type === 'output_pressure_fatal' && record.queue.incomingBytes === 200000))
})

test('persistent device socket blockage cancels rather than silently discarding the response', async (t) => {
  const { server, providers, input, logs } = await setup(t)
  const peer = [...server.sessions.values()][0]
  peer.output.canSend = () => false
  peer.output.stallTimeoutMs = 50
  await input.utterance()
  await waitFor(() => logs.some((record) => record.type === 'error' && record.code === 'OUTPUT_CONSUMER_STALLED'))
  assert.equal(providers[0].cancels, 1)
  assert.equal(peer.output.bytes, 0)
  assert.equal(peer.output.sequence, 0)
  assert.equal(peer.output.timer, null)
})

test('network loss under pressure clears old PCM and a reconfigured session plays a fresh turn', async (t) => {
  const { server, providers, input, session, output } = await setup(t)
  const peer = [...server.sessions.values()][0]
  peer.output.canSend = () => false
  await input.utterance()
  await waitFor(() => peer.output.bytes > 0)
  providers[0].emit('disconnected', {})
  await waitFor(() => providers.length === 2 && session.status === 'CONNECTED')
  assert.equal(peer.output.bytes, 0)
  assert.equal(peer.output.timer, null)
  assert.equal(providers[0].closed, true)
  assert.equal(providers[1].configured, true)
  providers[0].emit('audio_delta', { responseId: 'response-1', pcm: Buffer.alloc(960) })
  assert.equal(session.buffer.bytes, 0)
  assert.equal(output.playedBytes, 0)
  await input.utterance()
  await waitFor(() => session.phase === 'IDLE' && output.playedBytes === 2880)
  assert.equal(session.metrics.protocolErrors, 0)
})

test('temporary Provider connect errors retain stage/code and actual finite retry evidence', async (t) => {
  const { providers, logs } = await setup(t, { failures: 1 })
  assert.equal(providers.length, 2)
  assert(
    logs.some(
      (record) =>
        record.type === 'provider_failure' && record.code === 'PROVIDER_NETWORK_ERROR' && record.stage === 'connect',
    ),
  )
  assert.equal(logs.filter((record) => record.type === 'provider_retry').length, 1)
})

test('rejected device handshake logs only fixed status/code and never creates a Provider', async () => {
  const logs = []
  const server = await new AIServer({
    devices: [{ deviceId: 'robot-001', tokens: [token] }],
    providerFactory() {
      assert.fail('unauthorized request reached Provider')
    },
    log: (event) => logs.push(event),
    port: 0,
  }).start()
  try {
    const ws = new WebSocket(server.url, {
      headers: { 'X-Device-Id': 'robot-001', Authorization: 'Bearer private-wrong-token' },
    })
    const status = await new Promise((resolve, reject) => {
      ws.on('unexpected-response', (_request, response) => {
        const status = response.statusCode
        response.resume()
        ws.terminate()
        resolve(status)
      })
      ws.on('error', () => {})
      setTimeout(() => reject(new Error('handshake test timeout')), 1000).unref()
    })
    assert.equal(status, 401)
    assert.deepEqual(
      logs.find((e) => e.type === 'handshake_rejected'),
      { type: 'handshake_rejected', code: 'DEVICE_UNAUTHORIZED', httpStatus: 401 },
    )
    assert.equal(JSON.stringify(logs).includes('private-wrong-token'), false)
    assert.equal(server.sessions.size, 0)
  } finally {
    await server.close()
  }
})
