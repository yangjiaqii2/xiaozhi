import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import WebSocket, { WebSocketServer } from 'ws'
import { RealtimeSession } from '../../ai/realtime-session.js'
import { MockAudioInput } from '../../simulator/mock-audio-input.js'
import { MockAudioOutput } from '../../simulator/mock-audio-output.js'
import { createDeviceRuntime } from '../node-runtime.js'
import { ApiYiRealtimeProvider } from '../providers/apiyi/apiyi-realtime-provider.js'
import { modelConfig } from '../providers/apiyi/model-config.js'
import { AIServer } from '../server.js'

test('end-to-end actual WS sockets through APIyi adapter, with an explicitly offline upstream fixture', async () => {
  const vendor = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(vendor, 'listening')
  const secret = 'OFFLINE_ONLY_UPSTREAM_SECRET'
  const token = 'c'.repeat(32)
  const logs = []
  let chunks = 0
  let configured = false
  vendor.on('connection', (socket, request) => {
    assert.equal(request.headers.authorization, `Bearer ${secret}`)
    socket.send(JSON.stringify({ type: 'session.created' }))
    socket.on('message', (bytes) => {
      const event = JSON.parse(bytes.toString())
      if (event.type === 'session.update') {
        configured = true
        assert.equal(event.session.voice, 'Tina')
        socket.send(JSON.stringify({ type: 'session.updated', session: event.session }))
      } else if (event.type === 'input_audio_buffer.append') {
        chunks++
        assert(configured)
        if (chunks === 1) socket.send(JSON.stringify({ type: 'input_audio_buffer.speech_started', item_id: 'item1' }))
        if (chunks === 4) {
          for (const value of [
            { type: 'input_audio_buffer.speech_stopped', item_id: 'item1' },
            { type: 'response.created', response: { id: 'response1' } },
            { type: 'response.audio.delta', response_id: 'response1', delta: Buffer.alloc(2880).toString('base64') },
            {
              type: 'response.done',
              response: { id: 'response1', status: 'completed', usage: { input_tokens: 4, output_tokens: 3 } },
            },
          ])
            socket.send(JSON.stringify(value))
        }
      } else assert.notEqual(event.type, 'input_audio_buffer.commit', 'automatic VAD must not commit twice')
    })
  })
  const server = await new AIServer({
    port: 0,
    devices: [{ deviceId: 'robot-001', tokens: [token] }],
    log: (record) => logs.push(record),
    providerFactory: (_identity, onMetrics) =>
      new ApiYiRealtimeProvider({
        config: modelConfig(),
        env: { APIYI_API_KEY: secret },
        onMetrics,
        socketFactory: (_url, options) => new WebSocket(`ws://127.0.0.1:${vendor.address().port}`, options),
      }),
  }).start()
  const input = new MockAudioInput()
  const output = new MockAudioOutput()
  const session = new RealtimeSession({
    options: { url: server.url, deviceId: 'robot-001', connectionTimeoutMs: 1000 },
    runtime: createDeviceRuntime(() => ({ deviceId: 'robot-001', token })),
    wifi: { isConnected: () => true, onStatusChanged: () => () => {} },
    input,
    output,
  })
  const wait = async (condition) => {
    const deadline = performance.now() + 3000
    while (!condition()) {
      assert(performance.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
  }
  try {
    session.start()
    await wait(() => session.status === 'CONNECTED')
    await input.utterance()
    await wait(() => session.phase === 'IDLE' && output.playedChunks === 3)
    assert.equal(chunks, 4)
    assert.equal(output.playedBytes, 2880)
    assert.equal(session.metrics.protocolErrors, 0)
    assert(logs.some((record) => record.type === 'metrics' && record.provider.usage.input_tokens === 4))
    assert.equal(JSON.stringify(logs).includes(secret), false)
    assert.equal(JSON.stringify(logs).includes(token), false)
  } finally {
    session.dispose()
    await server.close()
    for (const socket of vendor.clients) socket.terminate()
    await new Promise((resolve) => vendor.close(resolve))
  }
})
