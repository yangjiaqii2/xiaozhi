import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import WebSocket from 'ws'
import { DeviceAuth } from '../auth.js'
import { AIServer } from '../server.js'

const token = 'a'.repeat(32)
const next = 'b'.repeat(32)
const headers = (value = token) => ({ 'x-device-id': 'unit-1', authorization: `Bearer ${value}` })
const record = (value, expiresAt = 2000) => ({ deviceId: 'unit-1', credentials: [{ token: value, expiresAt }] })

test('expiring credentials reject absent, wrong, future, expired and mismatched identities', () => {
  let now = 1000
  const auth = new DeviceAuth([record(token)], { now: () => now })
  assert.equal(auth.authenticate({}), null)
  assert.equal(auth.authenticate(headers(next)), null)
  assert.equal(auth.authenticate({ ...headers(), 'x-device-id': 'unit-2' }), null)
  assert.equal(auth.authenticate(headers()).deviceId, 'unit-1')
  now = 2000
  assert.equal(auth.authenticate(headers()), null)
  const future = new DeviceAuth([{ deviceId: 'unit-1', credentials: [{ token, notBefore: 3000, expiresAt: 4000 }] }], {
    now: () => now,
  })
  assert.equal(future.authenticate(headers()), null)
})
test('rotation revokes the old credential while keeping the new server identity', () => {
  const auth = new DeviceAuth([record(token)], { now: () => 1000 })
  const old = auth.authenticate(headers())
  auth.replace([{ ...record(next), personaId: 'server-persona', userId: 'server-user' }])
  assert.equal(auth.authenticate(headers()), null)
  assert.equal(auth.isCurrent(old), false)
  assert.equal(auth.authenticate(headers(next)).personaId, 'server-persona')
  assert.throws(() => auth.replace([]))
  assert(auth.authenticate(headers(next)))
})
test('strict connection nonce rejects missing, duplicate, stale and future admission replay with bounded storage', () => {
  let now = 1000
  const auth = new DeviceAuth([{ ...record(token, 1000000), requireNonce: true }], { now: () => now })
  const identity = auth.authenticate(headers())
  assert.equal(auth.acceptConnection(identity, headers()), false)
  const h = { ...headers(), 'x-device-nonce': 'c'.repeat(32), 'x-device-issued-at': '1000' }
  assert.equal(auth.acceptConnection(identity, h), true)
  assert.equal(auth.acceptConnection(identity, h), false)
  now = 62000
  assert.equal(auth.acceptConnection(identity, h), false)
  assert.equal(auth.acceptConnection(identity, { ...h, 'x-device-issued-at': '999999' }), false)
  for (let n = 0; n < 128; n++)
    assert(
      auth.acceptConnection(identity, {
        ...h,
        'x-device-nonce': n.toString(16).padStart(32, '0'),
        'x-device-issued-at': String(now),
      }),
    )
  assert.equal(auth.acceptConnection(identity, { ...h, 'x-device-issued-at': String(now) }), false)
})
test('live credential rotation closes old sessions and invalid identities never create Providers', async (t) => {
  let providers = 0
  const server = await new AIServer({
    port: 0,
    devices: [{ deviceId: 'unit-1', tokens: [token] }],
    providerFactory: () => {
      providers++
      assert.fail()
    },
  }).start()
  t.after(() => server.close())
  const socket = new WebSocket(server.url, { headers: headers() })
  socket.on('error', () => {})
  await once(socket, 'open')
  const closed = once(socket, 'close')
  server.updateDevices([{ deviceId: 'unit-1', tokens: [next] }])
  await closed
  assert.equal(server.sessions.size, 0)
  assert.equal(providers, 0)
})
test('active sessions close at server-side expiry without waiting for another client message', async (t) => {
  const server = await new AIServer({
    port: 0,
    devices: [record(token, Date.now() + 250)],
    providerFactory: () => assert.fail(),
  }).start()
  t.after(() => server.close())
  const socket = new WebSocket(server.url, { headers: headers() })
  socket.on('error', () => {})
  await once(socket, 'open')
  await once(socket, 'close')
  assert.equal(server.sessions.size, 0)
})
test('authenticated bootstrap config is returned before Provider creation and ignores client persona claims', async (t) => {
  const server = await new AIServer({
    port: 0,
    devices: [{ ...record(token, Date.now() + 10000), requireNonce: true, personaId: 'server-only' }],
    providerFactory: () => assert.fail('bootstrap must not connect provider'),
  }).start()
  t.after(() => server.close())
  const socket = new WebSocket(server.url, {
    headers: { ...headers(), 'x-device-nonce': 'n'.repeat(32), 'x-device-issued-at': String(Date.now()) },
  })
  socket.on('error', () => {})
  await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'device.config.get', requestId: 'setup-1', personaId: 'untrusted' }))
  const [bytes] = await once(socket, 'message')
  const message = JSON.parse(bytes.toString())
  assert.equal(message.type, 'device.config')
  assert.equal(message.requestId, 'setup-1')
  assert.equal(message.config.deviceId, 'unit-1')
  assert.equal(message.config.personaId, undefined)
  assert.equal(message.config.token, undefined)
  const closed = once(socket, 'close')
  socket.close()
  await closed
})
test('strict production admission requires expiring credentials and rejects indefinite legacy secrets', () => {
  assert.throws(
    () => new DeviceAuth([{ deviceId: 'unit-1', tokens: [token], requireNonce: true }]),
    /INVALID_DEVICE_CONFIG/,
  )
})
test('bootstrap traverses authenticated socket/config using strict credentials without constructing a Provider', async (t) => {
  const { randomBytes } = await import('node:crypto')
  const { DeviceIdentity } = await import('../../app/device-identity.js')
  const { DeviceBootstrap } = await import('../../app/device-bootstrap.js')
  const { openDeviceChannel } = await import('../../ai/device-channel.js')
  const { createDeviceRuntime } = await import('../node-runtime.js')
  const { realtimeOptions } = await import('../../ai/realtime-config.js')
  const { timer } = await import('../../simulator/runtime.js')
  const expiresAt = Date.now() + 10000
  const server = await new AIServer({
    port: 0,
    devices: [{ ...record(token, expiresAt), requireNonce: true }],
    providerFactory: () => assert.fail('no provider during setup'),
  }).start()
  t.after(() => server.close())
  const identity = new DeviceIdentity({ isTimeTrusted: () => true, nonce: () => randomBytes(16).toString('hex') })
  identity.provision({ deviceId: 'unit-1', token, expiresAt }, { confirmed: true })
  const runtime = createDeviceRuntime(() => identity.connectionCredentials())
  const bootstrap = new DeviceBootstrap({
    identity,
    wifi: { isConnected: () => true },
    time: { isTrusted: () => true },
    timer,
    timeoutMs: 500,
    openChannel: () => openDeviceChannel({ runtime, url: server.url, limits: realtimeOptions() }),
  })
  t.after(() => {
    bootstrap.dispose()
    identity.dispose()
  })
  const result = await bootstrap.start()
  assert.equal(result.configurationReady, true)
  assert.equal(result.code, 'AUDIO_DUPLEX_UNVERIFIED')
  assert.equal(bootstrap.getDiagnostics().audioStarted, false)
})
