import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiClient } from 'my-companion/api-client'
import { Clock, flush, httpRuntime, logger, response } from './helpers/network.mjs'

function fixture(scripts, overrides = {}) {
  const clock = new Clock()
  const runtime = httpRuntime(clock, scripts)
  const listeners = new Set()
  const wifi = {
    connected: true,
    isConnected() {
      return this.connected
    },
    onStatusChanged(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
  const options = {
    baseUrl: 'http://example.test:8080',
    deviceId: 'robot-001',
    token: '',
    timeoutMs: 100,
    maxResponseBytes: 128,
    maxRequestBytes: 128,
    retry: { enabled: true, maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 20 },
    tls: { minUnixTimeMs: 1704067200000 },
    ...overrides,
  }
  return { clock, runtime, wifi, listeners, client: new ApiClient(options, wifi, runtime, logger, logger) }
}

test('200 parses split UTF-8 fragments and closes resources', async () => {
  const f = fixture([
    (r) => {
      r.emit(1, 200)
      const bytes = new TextEncoder().encode('{"text":"小七"}')
      for (const byte of bytes) r.fragment(new Uint8Array([byte]))
      r.emit(5)
    },
  ])
  const result = f.client.get('/api/device/config')
  f.clock.advance(0)
  assert.deepEqual((await result).data, { text: '小七' })
  assert.equal(f.runtime.requests[0].closed, true)
  assert.equal(f.listeners.size, 0)
  assert.equal(f.clock.tasks.size, 0)
})

for (const [status, code] of [
  [302, 'REDIRECT'],
  [400, 'BAD_REQUEST'],
  [401, 'AUTH_ERROR'],
  [403, 'AUTH_ERROR'],
  [404, 'NOT_FOUND'],
  [429, 'RATE_LIMIT'],
  [500, 'SERVER_ERROR'],
]) {
  test(`${status} reports ${code} without retry`, async () => {
    const f = fixture([response(status)])
    const pending = assert.rejects(f.client.get('/test'), { code, status })
    f.clock.advance(0)
    await pending
    assert.equal(f.runtime.requests.length, 1)
    assert.equal(f.clock.tasks.size, 0)
  })
}

for (const status of [408, 502, 503, 504]) {
  test(`GET ${status} retries with same requestId and finite backoff`, async () => {
    const f = fixture([response(status), response(200)])
    const pending = f.client.get('/test')
    f.clock.advance(0)
    await flush()
    f.clock.advance(9)
    assert.equal(f.runtime.requests.length, 1)
    f.clock.advance(1)
    await flush()
    f.clock.advance(0)
    assert.equal((await pending).status, 200)
    assert.equal(f.runtime.requests.length, 2)
    assert.deepEqual(f.runtime.requests[0].options.headers, f.runtime.requests[1].options.headers)
  })
}

for (const [script, code] of [
  [() => {}, 'TIMEOUT'],
  [response(200, 'not JSON'), 'INVALID_JSON'],
  [response(200, 'x'.repeat(129)), 'RESPONSE_TOO_LARGE'],
  [
    (r) => {
      r.emit(1, 200)
      r.emit(2, 'content-length', '9999')
    },
    'RESPONSE_TOO_LARGE',
  ],
  [(r) => r.emit(-2), 'NETWORK_ERROR'],
]) {
  test(`handles ${code} and cleans up`, async () => {
    const f = fixture([script], { retry: { enabled: false } })
    const pending = assert.rejects(f.client.get('/test'), { code })
    f.clock.advance(100)
    await pending
    assert.equal(f.runtime.requests[0].closed, true)
    assert.equal(f.clock.tasks.size, 0)
    assert.equal(f.listeners.size, 0)
  })
}

test('POST encodes UTF-8 and never retries an ambiguous write', async () => {
  const f = fixture([response(503)])
  const pending = assert.rejects(f.client.post('/events', { text: '你好' }), { code: 'SERVER_ERROR' })
  f.clock.advance(0)
  await pending
  const request = f.runtime.requests[0]
  assert.equal(new TextDecoder().decode(request.options.body), '{"text":"你好"}')
  assert.equal(f.runtime.requests.length, 1)
})

test('one request at a time; close cancels an active request and forbids new requests', async () => {
  const f = fixture([() => {}])
  const pending = assert.rejects(f.client.get('/test'), { code: 'CANCELLED' })
  await assert.rejects(f.client.get('/test'), { code: 'BUSY' })
  f.client.close()
  await pending
  await assert.rejects(f.client.get('/test'), { code: 'CLOSED' })
  assert.equal(f.clock.tasks.size, 0)
})

test('disconnection cancels in-flight work; retries are finite', async () => {
  const f = fixture([(r) => r.emit(-2), (r) => r.emit(-2)])
  const pending = assert.rejects(f.client.get('/test'), { code: 'NETWORK_ERROR' })
  f.clock.advance(0)
  await flush()
  f.clock.advance(10)
  await flush()
  f.clock.advance(0)
  await pending
  assert.equal(f.runtime.requests.length, 2)
})

test('HTTPS without a compatible socket fails explicitly without plaintext fallback', async () => {
  const f = fixture([], { baseUrl: 'https://example.test' })
  await assert.rejects(f.client.get('/test'), { code: 'HTTPS_UNAVAILABLE' })
  assert.equal(f.runtime.requests.length, 0)
})

test('Wi-Fi loss aborts the socket immediately when observed', async () => {
  const f = fixture([() => {}], { retry: { enabled: false } })
  const pending = assert.rejects(f.client.get('/test'), { code: 'NETWORK_DISCONNECTED' })
  f.wifi.connected = false
  for (const listener of f.listeners) listener('DISCONNECTED')
  await pending
  assert.equal(f.runtime.requests[0].closed, true)
  assert.equal(f.clock.tasks.size, 0)
})

test('close during retry wait cancels the timer and never starts a second socket', async () => {
  const f = fixture([response(503), response(200)])
  const pending = assert.rejects(f.client.get('/test'), { code: 'CANCELLED' })
  f.clock.advance(0)
  await flush()
  f.client.close()
  await pending
  f.clock.advance(1000)
  assert.equal(f.runtime.requests.length, 1)
  assert.equal(f.clock.tasks.size, 0)
})

test('HTTPS options enforce verification and clock checks; transport failure is not misreported as a certificate diagnosis', async () => {
  const f = fixture([(r) => r.emit(-2)], { baseUrl: 'https://example.test', retry: { enabled: false } })
  class CompatibleSecureSocket {}
  f.runtime.secureSocket = () => CompatibleSecureSocket
  f.runtime.unixTime = () => 0
  await assert.rejects(f.client.get('/test'), { code: 'CLOCK_NOT_SET' })
  f.runtime.unixTime = () => Date.now()
  const pending = assert.rejects(f.client.get('/test'), { code: 'TLS_OR_NETWORK_ERROR' })
  f.clock.advance(0)
  await pending
  const options = f.runtime.requests[0].options
  assert.equal(options.Socket, CompatibleSecureSocket)
  assert.equal(options.secure.verify, true)
  assert.equal(options.secure.trace, false)
  assert.equal(options.port, 443)
})

for (const overrides of [
  { baseUrl: '' },
  { baseUrl: 'http://user:password@example.test' },
  { maxResponseBytes: 1000000 },
  { timeoutMs: NaN },
  { token: 'invalid\r\nheader' },
]) {
  test('invalid URL/header/buffer/time configuration fails before socket allocation', async () => {
    const f = fixture([], overrides)
    await assert.rejects(f.client.get('/test'), { code: 'INVALID_CONFIG' })
    assert.equal(f.runtime.requests.length, 0)
  })
}

test('logs omit credentials, paths with query secrets and full responses', async () => {
  const f = fixture([response(200, '{"secret":"FAKE_RESPONSE_SECRET"}')], { token: 'FAKE_TEST_TOKEN' })
  const logs = []
  f.client.logger = f.client.httpLogger = { debug: (line) => logs.push(line), error: (line) => logs.push(line) }
  const pending = f.client.get('/test?secret=FAKE_QUERY_SECRET')
  f.clock.advance(0)
  await pending
  assert(!logs.join().includes('FAKE_'))
  assert(logs.some((line) => line.includes('status=200')))
})
