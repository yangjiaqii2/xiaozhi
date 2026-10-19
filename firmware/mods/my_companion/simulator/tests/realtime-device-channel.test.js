import assert from 'node:assert/strict'
import test from 'node:test'
import { openDeviceChannel } from '../../ai/device-channel.js'

function fixture() {
  let events,
    closed = 0
  const sent = []
  const channel = openDeviceChannel({
    runtime: {
      id: () => 'setup-1',
      connect: (_url, callbacks) => {
        events = callbacks
        return { send: (v) => sent.push(JSON.parse(v)), close: () => closed++ }
      },
    },
    url: 'wss://example.com/api/realtime',
    limits: { maxControlBytes: 2048 },
  })
  return { channel, events, sent, closed: () => closed }
}
test('setup channel validates config request correlation, sends no session.start/audio, and releases on close', async () => {
  const f = fixture()
  f.events.open()
  await f.channel.ready
  const config = f.channel.getConfig()
  assert.deepEqual(f.sent, [{ type: 'device.config.get', requestId: 'setup-1' }])
  f.events.message(JSON.stringify({ type: 'device.config', requestId: 'setup-1', config: { deviceId: 'unit-1' } }))
  assert.equal((await config).deviceId, 'unit-1')
  f.channel.close()
  f.channel.close()
  assert.equal(f.closed(), 1)
})
for (const message of [
  '{}',
  'invalid',
  JSON.stringify({ type: 'device.config', requestId: 'other' }),
  new ArrayBuffer(20),
])
  test('invalid setup message fails closed without dumping message contents', async () => {
    const f = fixture()
    f.events.open()
    await f.channel.ready
    const config = f.channel.getConfig()
    f.events.message(message)
    await assert.rejects(config, /INVALID_PROTOCOL/)
    assert.equal(f.closed(), 1)
  })
test('TLS failure is surfaced and transport released, with no insecure retry', async () => {
  const f = fixture()
  f.events.error('TLS_OR_WEBSOCKET_ERROR')
  await assert.rejects(f.channel.ready, /TLS_OR_WEBSOCKET_ERROR/)
  assert.equal(f.closed(), 1)
})
