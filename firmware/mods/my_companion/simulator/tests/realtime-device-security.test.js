import assert from 'node:assert/strict'
import test from 'node:test'
import { DeviceBootstrap } from '../../app/device-bootstrap.js'
import { DeviceIdentity } from '../../app/device-identity.js'
import { TrustedTime } from '../../app/trusted-time.js'
import { timer } from '../runtime.js'

const secret = 'z'.repeat(32)
function identity() {
  let now = 1000
  let nonce = 0
  const value = new DeviceIdentity({
    unixTime: () => now,
    isTimeTrusted: () => true,
    nonce: () => String(++nonce).padStart(32, '0'),
  })
  const provision = (token = secret) =>
    value.provision({ deviceId: 'unit-1', token, expiresAt: 10000 }, { confirmed: true })
  return {
    value,
    provision,
    clock: (v) => {
      now = v
    },
  }
}
test('credentials require explicit local provisioning, are never serializable and fail after expiry', () => {
  const f = identity()
  assert.throws(() => f.value.connectionCredentials(), /DEVICE_UNAUTHORIZED/)
  assert.throws(
    () => f.value.provision({ deviceId: 'unit-1', token: secret, expiresAt: 10000 }),
    /EXPLICIT_PROVISION_REQUIRED/,
  )
  f.provision()
  assert.equal(f.value.connectionCredentials().token, secret)
  assert.equal(JSON.stringify(f.value).includes(secret), false)
  assert.equal(JSON.stringify(f.value.getDiagnostics()).includes(secret), false)
  f.clock(10000)
  assert.throws(() => f.value.connectionCredentials(), /CREDENTIAL_EXPIRED/)
})
test('rotation and authorization failure invalidate current work and require explicit new provisioning', () => {
  const f = identity()
  let changes = 0
  f.value.onChange(() => changes++)
  f.provision()
  f.value.reject()
  assert.throws(() => f.value.connectionCredentials(), /DEVICE_UNAUTHORIZED/)
  f.provision('y'.repeat(32))
  assert.equal(f.value.connectionCredentials().token, 'y'.repeat(32))
  assert.equal(changes, 3)
  f.value.dispose()
  f.value.dispose()
  assert.throws(() => f.value.connectionCredentials(), /DISPOSED/)
})
test('device admission requires trusted expiry clock and unique nonce adapter, not model keys or user claims', () => {
  const f = new DeviceIdentity({ unixTime: () => 1000, isTimeTrusted: () => false })
  f.provision({ deviceId: 'unit-1', token: secret, expiresAt: 10000, userId: 'untrusted' }, { confirmed: true })
  assert.throws(() => f.connectionCredentials(), /TIME_UNVERIFIED/)
  const g = new DeviceIdentity({ unixTime: () => 1000, isTimeTrusted: () => true })
  g.provision({ deviceId: 'unit-1', token: secret, expiresAt: 10000 }, { confirmed: true })
  assert.throws(() => g.connectionCredentials(), /NONCE_UNAVAILABLE/)
})
function timeFixture(options = {}) {
  let ticks = 0,
    unix = 0,
    complete,
    closes = 0
  const service = new TrustedTime({
    runtime: {
      timer,
      now: () => ticks,
      elapsed: (a, b) => b - a,
      unixTime: () => unix,
      setTime: (seconds) => {
        unix = seconds * 1000
      },
      sync: (callback) => {
        complete = callback
        return { close: () => closes++ }
      },
    },
    wifi: { isConnected: () => true },
    timeoutMs: 20,
    ...options,
  })
  return {
    service,
    complete: (value) => complete(null, value),
    tick: (n) => {
      ticks = n
    },
    closes: () => closes,
  }
}
test('ordinary SNTP is synchronized but never authenticated time; repeated sync owns one resource', async () => {
  const f = timeFixture()
  const a = f.service.sync(),
    b = f.service.sync()
  assert.equal(a, b)
  f.complete(1800000000)
  assert.equal((await a).code, 'TIME_UNVERIFIED')
  assert.equal(f.service.getDiagnostics().synchronized, true)
  assert.equal(f.service.isTrusted(), false)
  assert.equal(f.closes(), 1)
})
test('verified time evidence expires on monotonic lifetime and rejects clock changes', async () => {
  const f = timeFixture({ verifyEvidence: (proof) => proof.signature === 'verified-by-fixture' })
  assert.equal(f.service.acceptEvidence({ unixMs: 1800000000000, validForMs: 100, signature: 'invalid' }), false)
  assert(f.service.acceptEvidence({ unixMs: 1800000000000, validForMs: 100, signature: 'verified-by-fixture' }))
  assert(f.service.isTrusted())
  f.tick(101)
  assert.equal(f.service.isTrusted(), false)
})
test('offline time synchronization creates no network task; timeout and cancel close once and ignore late replies', async () => {
  const offline = timeFixture({ wifi: { isConnected: () => false } })
  assert.equal((await offline.service.sync()).code, 'NETWORK_DISCONNECTED')
  const f = timeFixture()
  assert.equal((await f.service.sync()).code, 'TIME_SYNC_TIMEOUT')
  assert.equal(f.closes(), 1)
  f.complete(1800000000)
  assert.equal(f.service.getDiagnostics().synchronized, false)
  const pending = f.service.sync()
  f.service.stop()
  f.service.stop()
  assert.equal((await pending).code, 'CANCELLED')
  assert.equal(f.closes(), 2)
})
function bootstrapFixture(overrides = {}) {
  const f = identity()
  f.provision()
  let closed = 0,
    connects = 0
  const wifi = { isConnected: () => true, onStatusChanged: () => () => {} }
  const bootstrap = new DeviceBootstrap({
    identity: f.value,
    wifi,
    time: { isTrusted: () => true },
    timer,
    timeoutMs: 20,
    openChannel: () => {
      connects++
      return {
        ready: Promise.resolve(),
        getConfig: async () => ({ deviceId: 'unit-1', features: { voiceChat: true } }),
        close: () => closed++,
      }
    },
    ...overrides,
  })
  return { ...f, bootstrap, closed: () => closed, connects: () => connects }
}
test('bootstrap checks credentials, safely fetches config and never starts duplex audio automatically', async () => {
  const f = bootstrapFixture()
  const a = f.bootstrap.start(),
    b = f.bootstrap.start()
  assert.equal(a, b)
  assert.equal((await a).code, 'AUDIO_DUPLEX_UNVERIFIED')
  assert.equal(f.bootstrap.getDiagnostics().stages.config, 'PASS')
  assert.equal(f.closed(), 1)
  assert.equal(f.connects(), 1)
  assert.equal((await f.bootstrap.start()).code, 'AUDIO_DUPLEX_UNVERIFIED')
  assert.equal(f.connects(), 1)
})
for (const [name, options, code] of [
  ['offline', { wifi: { isConnected: () => false } }, 'NETWORK_DISCONNECTED'],
  [
    'untrusted time',
    { time: { isTrusted: () => false, sync: async () => ({ code: 'TIME_UNVERIFIED' }) } },
    'TIME_UNVERIFIED',
  ],
  [
    'TLS failure',
    { openChannel: () => ({ ready: Promise.reject(new Error('TLS_OR_WEBSOCKET_ERROR')), close() {} }) },
    'TLS_OR_WEBSOCKET_ERROR',
  ],
  ['handshake timeout', { openChannel: () => ({ ready: new Promise(() => {}), close() {} }) }, 'BOOTSTRAP_TIMEOUT'],
  [
    'identity mismatch',
    { openChannel: () => ({ ready: Promise.resolve(), getConfig: async () => ({ deviceId: 'other' }), close() {} }) },
    'DEVICE_UNAUTHORIZED',
  ],
])
  test(`bootstrap handles ${name} without retrying providers or starting audio`, async () => {
    const f = bootstrapFixture(options)
    assert.equal((await f.bootstrap.start()).code, code)
    assert.equal((await f.bootstrap.start()).code, code)
    f.bootstrap.dispose()
    f.bootstrap.dispose()
  })
test('bootstrap cancels in-flight channel on stop, provisioning rotation and Wi-Fi loss', async () => {
  for (const action of ['stop', 'rotation', 'wifi']) {
    let changed
    const f = bootstrapFixture({
      wifi: {
        isConnected: () => true,
        onStatusChanged: (fn) => {
          changed = fn
          return () => {
            changed = null
          }
        },
      },
      openChannel: () => ({ ready: new Promise(() => {}), close() {} }),
    })
    const pending = f.bootstrap.start()
    await new Promise((r) => setTimeout(r, 0))
    if (action === 'stop') f.bootstrap.stop()
    else if (action === 'rotation') f.provision('y'.repeat(32))
    else changed('DISCONNECTED')
    assert.equal((await pending).ok, false)
    assert.equal(f.bootstrap.getDiagnostics().channelOwned, false)
    f.bootstrap.dispose()
    assert.equal(changed, null)
  }
})
test('stop before first microtask creates no channel and a cancelled run can be retried', async () => {
  const f = bootstrapFixture()
  const pending = f.bootstrap.start()
  f.bootstrap.stop()
  assert.equal((await pending).code, 'CANCELLED')
  assert.equal(f.connects(), 0)
  assert.equal((await f.bootstrap.start()).code, 'AUDIO_DUPLEX_UNVERIFIED')
  assert.equal(f.connects(), 1)
  f.bootstrap.dispose()
})
test('unprovisioned bootstrap cannot create a WSS connection', async () => {
  const f = bootstrapFixture({ identity: identity().value })
  assert.equal((await f.bootstrap.start()).code, 'DEVICE_UNAUTHORIZED')
  assert.equal(f.connects(), 0)
  f.bootstrap.dispose()
})
test('manual bootstrap retry recovers from TLS rejection and releases previous channel exactly once', async () => {
  let attempts = 0,
    closes = 0
  const f = bootstrapFixture({
    openChannel: () => ({
      ready: ++attempts === 1 ? Promise.reject(new Error('TLS_OR_WEBSOCKET_ERROR')) : Promise.resolve(),
      getConfig: async () => ({ deviceId: 'unit-1' }),
      close: () => closes++,
    }),
  })
  assert.equal((await f.bootstrap.start()).code, 'TLS_OR_WEBSOCKET_ERROR')
  assert.equal(attempts, 1)
  f.bootstrap.stop()
  assert.equal((await f.bootstrap.start()).configurationReady, true)
  assert.equal(attempts, 2)
  assert.equal(closes, 2)
  f.bootstrap.dispose()
})
test('untrusted remote booleans never become trusted time evidence', () => {
  const f = timeFixture()
  assert.equal(
    f.service.acceptEvidence({ unixMs: 1800000000000, validForMs: 1000, trusted: true, synchronized: true }),
    false,
  )
  assert.equal(f.service.isTrusted(), false)
})

test('expired credentials and missing nonce fail closed without reconnect timers', async () => {
  const { RealtimeSession } = await import('../../ai/realtime-session.js')
  const { createMockRealtimeRuntime } = await import('../mock-realtime-runtime.js')
  const { MockAudioInput } = await import('../mock-audio-input.js')
  const { MockAudioOutput } = await import('../mock-audio-output.js')
  for (const code of ['CREDENTIAL_EXPIRED', 'NONCE_UNAVAILABLE']) {
    let attempts = 0
    const runtime = createMockRealtimeRuntime()
    runtime.connect = () => {
      attempts++
      throw Object.assign(new Error(code), { code })
    }
    const session = new RealtimeSession({
      runtime,
      options: { url: 'wss://example.com/api/realtime', deviceId: 'unit-1' },
      wifi: { isConnected: () => true, onStatusChanged: () => () => {} },
      input: new MockAudioInput(),
      output: new MockAudioOutput(),
    })
    try {
      session.start()
      assert.equal(session.status, 'ERROR')
      assert.equal(attempts, 1)
      assert.equal(session.timers.size, 0)
    } finally {
      session.dispose()
    }
  }
})
test('cached bootstrap cannot mask expired credentials on the next explicit check', async () => {
  const f = bootstrapFixture()
  assert.equal((await f.bootstrap.start()).configurationReady, true)
  f.clock(10000)
  assert.equal((await f.bootstrap.start()).code, 'CREDENTIAL_EXPIRED')
  assert.equal(f.connects(), 1)
  f.bootstrap.dispose()
})
