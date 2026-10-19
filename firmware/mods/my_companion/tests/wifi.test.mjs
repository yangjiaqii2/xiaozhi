import assert from 'node:assert/strict'
import test from 'node:test'
import { WiFiController, WiFiStatus } from 'my-companion/wifi'
import { Clock, logger } from './helpers/network.mjs'

function fixture(state = 4, reconnect = true) {
  const clock = new Clock()
  const states = {
    IDLE: 0,
    SCANNING: 1,
    CONNECTING: 2,
    SYNCING_TIME: 3,
    CONNECTED: 4,
    RECONNECTING: 5,
    FAILED: 6,
    CLOSED: 7,
  }
  const calls = []
  let service = state === null ? undefined : { state }
  const runtime = {
    timer: clock,
    now: clock.now,
    elapsed: clock.elapsed,
    states,
    get: () => service,
    stop() {
      calls.push('stop')
      service = undefined
    },
    start(options) {
      calls.push('start')
      service = { state: states.CONNECTING, options }
      return service
    },
    credentials: () => ({ ssid: 'test-only', password: '' }),
  }
  const wifi = new WiFiController(
    { ready: Promise.resolve({ status: 'connected' }) },
    {
      pollMs: 10,
      connectionTimeoutMs: 100,
      reconnect: { enabled: reconnect, initialDelayMs: 20, maxDelayMs: 80 },
    },
    runtime,
    logger,
  )
  return {
    wifi,
    clock,
    runtime,
    calls,
    get service() {
      return service
    },
  }
}

test('adopts CONNECTED host singleton and leaves it connected on close', () => {
  const f = fixture()
  f.wifi.connect()
  assert.equal(f.wifi.getStatus(), WiFiStatus.CONNECTED)
  assert.equal(f.wifi.isConnected(), true)
  f.wifi.close()
  assert.deepEqual(f.calls, [])
  assert.equal(f.clock.tasks.size, 0)
})

test('disconnect publishes DISCONNECTED; explicit reconnect works', () => {
  const f = fixture()
  f.wifi.connect()
  f.wifi.disconnect()
  assert.equal(f.wifi.getStatus(), WiFiStatus.DISCONNECTED)
  f.clock.advance(1000)
  assert.deepEqual(f.calls, ['stop'])
  f.wifi.connect()
  assert.equal(f.wifi.getStatus(), WiFiStatus.CONNECTING)
  f.wifi.close()
})

test('loss uses capped backoff and resets after successful connection', () => {
  const f = fixture()
  const observed = []
  f.wifi.onStatusChanged((state) => observed.push(state))
  f.wifi.connect()
  f.service.state = 5
  f.clock.advance(10)
  assert.equal(f.wifi.getStatus(), WiFiStatus.RECONNECTING)
  f.clock.advance(20)
  assert.equal(f.calls.filter((v) => v === 'start').length, 1)
  f.service.state = 6
  f.clock.advance(10)
  f.clock.advance(39)
  assert.equal(f.calls.filter((v) => v === 'start').length, 1)
  f.clock.advance(1)
  assert.equal(f.calls.filter((v) => v === 'start').length, 2)
  f.service.state = 4
  f.clock.advance(10)
  assert.equal(f.wifi.isConnected(), true)
  assert(observed.includes(WiFiStatus.ERROR))
  assert(observed.includes(WiFiStatus.RECONNECTING))
  f.wifi.close()
})

test('disabled retry and absent credentials cannot spin or create connections', () => {
  const f = fixture(6, false)
  f.wifi.connect()
  f.clock.advance(1000)
  assert.equal(f.calls.includes('start'), false)
  assert.equal(f.wifi.getStatus(), WiFiStatus.ERROR)
  f.wifi.close()
  const missing = fixture(null)
  missing.runtime.credentials = () => ({ ssid: '', password: '' })
  missing.wifi.connect()
  missing.clock.advance(1000)
  assert.equal(missing.calls.includes('start'), false)
  assert.equal(missing.wifi.getStatus(), WiFiStatus.ERROR)
  missing.wifi.close()
})

test('repeated failures cap retry delay and a successful connection resets the sequence', () => {
  const f = fixture()
  f.wifi.connect()
  f.service.state = 5
  for (const delay of [20, 40, 80, 80]) {
    f.clock.advance(10)
    const before = f.calls.filter((value) => value === 'start').length
    f.clock.advance(delay - 1)
    assert.equal(f.calls.filter((value) => value === 'start').length, before)
    f.clock.advance(1)
    assert.equal(f.calls.filter((value) => value === 'start').length, before + 1)
    f.service.state = 6
  }
  f.service.state = 4
  f.clock.advance(10)
  f.service.state = 5
  f.clock.advance(10)
  const before = f.calls.filter((value) => value === 'start').length
  f.clock.advance(20)
  assert.equal(f.calls.filter((value) => value === 'start').length, before + 1)
  f.wifi.close()
  assert.equal(f.clock.tasks.size, 0)
})

test('a stalled native connection has a watchdog and close cancels its pending reconnect', () => {
  const f = fixture(2)
  f.wifi.connect()
  f.clock.advance(100)
  assert.equal(f.wifi.getStatus(), WiFiStatus.RECONNECTING)
  assert.deepEqual(f.calls, ['stop'])
  f.wifi.close()
  f.clock.advance(1000)
  assert.deepEqual(f.calls, ['stop'])
  assert.equal(f.clock.tasks.size, 0)
})

test('native connection and shutdown exceptions are contained and cannot create a retry storm', () => {
  const f = fixture(null)
  let attempts = 0
  f.runtime.start = () => {
    attempts += 1
    throw new Error('native failure')
  }
  assert.doesNotThrow(() => f.wifi.connect())
  assert.equal(attempts, 1)
  f.clock.advance(19)
  assert.equal(attempts, 1)
  f.clock.advance(1)
  assert.equal(attempts, 2)
  f.wifi.close()
  const shutdown = fixture()
  shutdown.wifi.connect()
  shutdown.runtime.stop = () => {
    throw new Error('native shutdown failure')
  }
  assert.doesNotThrow(() => shutdown.wifi.disconnect())
  assert.equal(shutdown.wifi.getStatus(), WiFiStatus.ERROR)
  shutdown.wifi.close()
})

test('invalid timing is rejected before any timer or connection is created', () => {
  const f = fixture()
  f.wifi.options.pollMs = 0
  f.wifi.connect()
  assert.equal(f.wifi.getStatus(), WiFiStatus.ERROR)
  assert.equal(f.clock.tasks.size, 0)
  assert.deepEqual(f.calls, [])
  f.wifi.close()
})
