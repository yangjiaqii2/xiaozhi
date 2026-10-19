import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { ApiYiRealtimeProvider } from '../providers/apiyi/apiyi-realtime-provider.js'
import { modelConfig } from '../providers/apiyi/model-config.js'

const env = { APIYI_API_KEY: 'OFFLINE_TEST_CREDENTIAL' }
class Socket extends EventEmitter {
  constructor() {
    super()
    this.readyState = 1
    this.bufferedAmount = 0
    this.sent = []
    this.terminated = false
  }
  send(text, done) {
    const event = JSON.parse(text)
    this.sent.push(event)
    if (event.type === 'session.update') queueMicrotask(() => this.deliver({ type: 'session.updated' }))
    done?.()
  }
  deliver(event) {
    this.emit('message', Buffer.from(JSON.stringify(event)), false)
  }
  terminate() {
    this.terminated = true
    this.readyState = 3
  }
}
async function setup(t, options = {}) {
  let socket
  let transport
  const records = []
  const provider = new ApiYiRealtimeProvider({
    env,
    config: modelConfig(options.model, options.config),
    connectTimeoutMs: 100,
    cancelTimeoutMs: 30,
    idleMs: 5000,
    ...options.provider,
    onMetrics: (value) => records.push(value),
    socketFactory: (url, config) => {
      transport = { url, config }
      socket = new Socket()
      queueMicrotask(() => {
        socket.emit('open')
        socket.deliver({ type: 'session.created' })
      })
      return socket
    },
  })
  t.after(() => provider.close())
  await provider.connect()
  return { provider, socket, records, transport }
}

test('WSS auth, first update pins voice, session_ready after update and no reconfiguration', async (t) => {
  const { provider, socket, transport } = await setup(t)
  assert(transport.url.startsWith('wss://api.apiyi.com/v1/realtime?model='))
  assert.equal(transport.config.headers.Authorization, `Bearer ${env.APIYI_API_KEY}`)
  assert.equal(transport.config.rejectUnauthorized, true)
  assert.equal(transport.config.followRedirects, false)
  assert.equal(socket.sent[0].session.voice, 'Tina')
  assert(provider.ready)
  assert.throws(() => provider.configureSession(), /ALREADY_CONFIGURED/)
})

for (const [model, audioType, textType] of [
  ['qwen3.5-omni-flash-realtime', 'response.audio.delta', 'response.text.delta'],
  ['gpt-realtime-2.1-mini', 'response.output_audio.delta', 'response.output_text.delta'],
]) {
  test(`${model}: streamed audio/text normalization, usage and real metric clocks`, async (t) => {
    const { provider, socket, records } = await setup(t, { model })
    let audioBytes = 0
    let text = ''
    provider.on('audio_delta', ({ pcm }) => {
      audioBytes += pcm.length
    })
    provider.on('text_delta', ({ delta }) => {
      text += delta
    })
    provider.sendAudioChunk(Buffer.alloc(640))
    const appended = socket.sent.find((event) => event.type === 'input_audio_buffer.append')
    assert.equal(Buffer.from(appended.audio, 'base64').length, provider.config.family === 'ga' ? 958 : 640)
    socket.deliver({ type: 'response.created', response: { id: 'r1' } })
    socket.deliver({ type: textType, response_id: 'r1', delta: 'hello' })
    socket.deliver({ type: audioType, response_id: 'r1', delta: Buffer.alloc(960).toString('base64') })
    assert.equal(audioBytes, 960)
    assert.equal(records.length, 0)
    socket.deliver({
      type: 'response.done',
      response: {
        id: 'r1',
        status: 'completed',
        usage: { input_tokens: 1, output_tokens: 2, private: env.APIYI_API_KEY },
      },
    })
    assert.equal(text, 'hello')
    assert.equal(records.length, 1)
    assert(provider.metrics.TTFA >= 0)
    assert(provider.metrics.total_response_time >= provider.metrics.TTFA)
    assert.equal(JSON.stringify(records).includes(env.APIYI_API_KEY), false)
    assert.deepEqual(provider.metrics.usage, { input_tokens: 1, output_tokens: 2 })
  })
}

test('Qwen cancel ends on output_item.done without response.done; stale audio never escapes', async (t) => {
  const { provider, socket } = await setup(t)
  let audio = 0
  provider.on('audio_delta', () => audio++)
  socket.deliver({ type: 'response.created', response: { id: 'r1' } })
  const cancel = provider.cancelResponse()
  assert.equal(provider.cancelResponse(), cancel)
  socket.deliver({ type: 'response.audio.delta', response_id: 'r1', delta: Buffer.alloc(960).toString('base64') })
  socket.deliver({ type: 'response.output_item.done', response_id: 'r1', item: { type: 'message' } })
  assert.equal((await cancel).reason, 'output_item.done')
  assert.equal(audio, 0)
  assert.equal(provider.closed, false)
  socket.deliver({ type: 'response.created', response: { id: 'r2' } })
  socket.deliver({ type: 'response.audio.delta', response_id: 'r1', delta: Buffer.alloc(960).toString('base64') })
  assert.equal(audio, 0)
})

test('cancel timeout is finite and closes uncertain upstream generation', async (t) => {
  const { provider, socket } = await setup(t)
  socket.deliver({ type: 'response.created', response: { id: 'r1' } })
  assert.equal((await provider.cancelResponse()).reason, 'timeout')
  assert(provider.closed)
  assert(socket.terminated)
  assert.equal(provider.timers.size, 0)
})

test('cancelling a function-call output item also closes on output_item.done', async (t) => {
  const { provider, socket } = await setup(t)
  socket.deliver({ type: 'response.created', response: { id: 'r1' } })
  const cancel = provider.cancelResponse()
  socket.deliver({ type: 'response.output_item.done', response_id: 'r1', item: { type: 'function_call' } })
  assert.equal((await cancel).reason, 'output_item.done')
  assert.equal(provider.closed, false)
})

test('manual commit guarded, malformed peer message and input backpressure fail safely', async (t) => {
  const { provider, socket } = await setup(t)
  assert.throws(() => provider.commitInput(), /MANUAL_COMMIT_DISABLED/)
  socket.bufferedAmount = 200000
  assert.throws(() => provider.sendAudioChunk(Buffer.alloc(640)), /PROVIDER_BACKPRESSURE/)
  socket.bufferedAmount = 0
  socket.emit('message', Buffer.from('{'), false)
  assert(provider.closed)
  assert.equal(provider.timers.size, 0)
})

test('connect timeout and idle expiry release resources without infinite retry', async (t) => {
  const socket = new Socket()
  const provider = new ApiYiRealtimeProvider({ env, connectTimeoutMs: 10, socketFactory: () => socket })
  await assert.rejects(provider.connect(), /PROVIDER_UNAVAILABLE/)
  assert(provider.closed)
  assert(socket.terminated)
  const idle = await setup(t, { provider: { idleMs: 10 } })
  await new Promise((resolve) => idle.provider.once('disconnected', resolve))
  assert(idle.provider.closed)
})

test('missing server environment key never starts transport', async () => {
  const provider = new ApiYiRealtimeProvider({
    env: {},
    socketFactory() {
      assert.fail('must not connect')
    },
  })
  await assert.rejects(provider.connect(), /APIYI_KEY_MISSING/)
  provider.close()
  provider.close()
})

test('unassigned/null response audio cannot enter playback and old created events cannot revive cancelled output', async (t) => {
  const { provider, socket } = await setup(t)
  let audio = 0
  provider.on('audio_delta', () => audio++)
  socket.deliver({ type: 'response.audio.delta', response_id: null, delta: Buffer.alloc(960).toString('base64') })
  assert.equal(audio, 0)
  socket.deliver({ type: 'response.created', response: { id: 'old' } })
  const cancelled = provider.cancelResponse()
  socket.deliver({ type: 'response.output_item.done', response_id: 'old', item: { type: 'message' } })
  await cancelled
  socket.deliver({ type: 'response.created', response: { id: 'new' } })
  socket.deliver({ type: 'response.created', response: { id: 'old' } })
  assert.equal(provider.activeResponse, 'new')
})

test('a late error referencing an already acknowledged cancel cannot kill the next response', async (t) => {
  const { provider, socket } = await setup(t)
  socket.deliver({ type: 'response.created', response: { id: 'old' } })
  const pending = provider.cancelResponse()
  const cancel = socket.sent.find((event) => event.type === 'response.cancel')
  assert.equal(cancel.response_id, undefined)
  socket.deliver({ type: 'response.output_item.done', response_id: 'old', item: { type: 'message' } })
  await pending
  socket.deliver({ type: 'response.created', response: { id: 'new' } })
  socket.deliver({ type: 'error', error: { event_id: cancel.event_id } })
  assert.equal(provider.closed, false)
  assert.equal(provider.activeResponse, 'new')
})

test('HTTP upgrade diagnostics retain only numeric status and never raw response or headers', async (t) => {
  const { provider, socket } = await setup(t)
  let drained = false
  socket.emit(
    'unexpected-response',
    { headers: { Authorization: 'PRIVATE' } },
    {
      statusCode: 503,
      resume() {
        drained = true
      },
    },
  )
  assert(drained)
  assert.deepEqual(provider.lastFailure, { code: 'PROVIDER_UPGRADE_ERROR', httpStatus: 503 })
  assert.equal(JSON.stringify(provider.lastFailure).includes('PRIVATE'), false)
})

test('Qwen automatic VAD can finish output item before speech_started triggers cancel', async (t) => {
  const { provider, socket } = await setup(t)
  socket.deliver({ type: 'response.created', response: { id: 'old' } })
  socket.deliver({ type: 'response.output_item.done', response_id: 'old', item: { type: 'message' } })
  const cancelled = provider.cancelResponse()
  assert.equal(provider.cancelPending, null, 'known output-item ACK must not be awaited again')
  assert.equal((await cancelled).reason, 'output_item.done_before_cancel')
  assert.equal(
    socket.sent.filter((event) => event.type === 'response.cancel').length,
    0,
    'a late unscoped cancel could cancel the already-starting next response',
  )
  assert.equal(provider.metrics.interruption_latency, null, 'ACK before cancel is not a measured RTT')
  let bytes = 0
  provider.on('audio_delta', ({ pcm }) => {
    bytes += pcm.length
  })
  socket.deliver({ type: 'response.created', response: { id: 'new' } })
  socket.deliver({ type: 'response.audio.delta', response_id: 'old', delta: Buffer.alloc(960).toString('base64') })
  socket.deliver({ type: 'response.audio.delta', response_id: 'new', delta: Buffer.alloc(960).toString('base64') })
  assert.equal(bytes, 960)
  assert.equal(provider.activeResponse, 'new')
  assert.equal(provider.closed, false)
})
