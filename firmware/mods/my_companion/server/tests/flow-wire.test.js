import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import WebSocket, { WebSocketServer } from 'ws'
import { OutputStream } from '../output-stream.js'
import { ApiYiRealtimeProvider } from '../providers/apiyi/apiyi-realtime-provider.js'
import { modelConfig } from '../providers/apiyi/model-config.js'

// Explicit offline wire fixture: verifies ws.pause/resume, not APIyi service behavior.
test('real WS receive throttling drains a long fast stream and resumes before cancellation', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(server, 'listening')
  const jobs = new Set()
  let cancelReceived = false
  server.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'session.created' }))
    socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString())
      if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }))
      if (event.type === 'response.cancel') {
        cancelReceived = true
        socket.send(JSON.stringify({ type: 'response.output_item.done', response_id: 'r2', item: { id: 'i2' } }))
      }
    })
  })
  const provider = new ApiYiRealtimeProvider({
    env: { APIYI_API_KEY: 'OFFLINE_ONLY' },
    config: modelConfig(),
    socketFactory: (_url, options) => new WebSocket(`ws://127.0.0.1:${server.address().port}`, options),
  })
  let received = 0
  const errors = []
  const stream = new OutputStream({
    send: (frame) => {
      received += frame.byteLength - 16
    },
    onDrain() {},
    onError: (e) => errors.push(e),
    onPressure: (value) => provider.setOutputPaused(value),
  })
  provider.on('error', (event) => errors.push(event.code))
  provider.on('audio_delta', (event) => stream.push(event.pcm))
  const wait = async (check) => {
    const deadline = performance.now() + 10000
    while (!check()) {
      assert(performance.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  try {
    await provider.connect()
    const upstream = [...server.clients][0]
    stream.begin(1)
    upstream.send(JSON.stringify({ type: 'response.created', response: { id: 'r1' } }))
    for (let n = 0; n < 20; n++) {
      const job = setTimeout(
        () =>
          upstream.send(
            JSON.stringify({
              type: 'response.audio.delta',
              response_id: 'r1',
              delta: Buffer.alloc(15360).toString('base64'),
            }),
          ),
        n * 5,
      )
      jobs.add(job)
    }
    await wait(() => received === 20 * 15360 && stream.bytes === 0)
    assert.deepEqual(errors, [])
    assert(stream.stats.pressureCount > 0)
    assert(stream.stats.peakBytes <= 192000)
    upstream.send(JSON.stringify({ type: 'response.done', response: { id: 'r1', status: 'completed' } }))
    upstream.send(JSON.stringify({ type: 'response.created', response: { id: 'r2' } }))
    await wait(() => provider.activeResponse === 'r2')
    provider.setOutputPaused(true)
    const cancelled = provider.cancelResponse()
    assert.equal(provider.outputPaused, false)
    await cancelled
    assert(cancelReceived)
    const before = received
    upstream.send(
      JSON.stringify({ type: 'response.audio.delta', response_id: 'r2', delta: Buffer.alloc(960).toString('base64') }),
    )
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(received, before, 'cancelled late PCM must not enter output queue')
  } finally {
    for (const job of jobs) clearTimeout(job)
    stream.clear()
    provider.close()
    for (const socket of server.clients) socket.terminate()
    await new Promise((resolve) => server.close(resolve))
  }
})
