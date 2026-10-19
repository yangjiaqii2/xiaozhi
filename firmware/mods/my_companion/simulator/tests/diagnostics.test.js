import assert from 'node:assert/strict'
import test from 'node:test'
import { diagnosticSnapshot } from '../../hardware/diagnostics.js'

test('diagnostics are bounded read-only observations, without initializing or starting audio', () => {
  let reads = 0
  const microphone = {
    recording: false,
    start() {
      assert.fail('must not record')
    },
  }
  const robot = {
    audio: {
      get microphone() {
        reads++
        return microphone
      },
      start() {
        assert.fail()
      },
    },
  }
  const snapshot = diagnosticSnapshot({
    robot,
    companion: { wifi: { getStatus: () => 'CONNECTED' } },
    realtime: {
      status: 'CONNECTED',
      lastError: 'Authorization: secret',
      metrics: { timeToFirstAudio: 100, audioBytesReceived: Infinity, token: 'secret' },
    },
  })
  assert.equal(reads, 1)
  assert.equal(snapshot.microphone.initialization, 'UNKNOWN')
  assert.equal(snapshot.wifi, 'CONNECTED')
  assert.equal(snapshot.clock, 'TIME_UNVERIFIED')
  assert.equal(snapshot.i2s.status, 'AUDIO_DUPLEX_UNVERIFIED')
  assert.equal(snapshot.metrics.audioBytesReceived, null)
  assert.equal(JSON.stringify(snapshot).includes('secret'), false)
  assert.equal(snapshot.speaker.initialization, 'UNKNOWN')
})

test('absent hardware remains unknown; active recording is observed without changing it', () => {
  assert.equal(diagnosticSnapshot().wifi, 'UNKNOWN')
  assert.equal(diagnosticSnapshot().microphone.recording, null)
  assert.equal(
    diagnosticSnapshot({ robot: { audio: { microphone: { recording: true } } } }).microphone.initialization,
    'ACTIVE',
  )
})

test('read-only diagnostics expose measured interruption stages without declaring hardware checks passed', () => {
  const result = diagnosticSnapshot({
    realtime: {
      status: 'STOPPED',
      phase: 'LISTENING',
      runtime: { elapsed: (a, b) => b - a },
      lastInterruption: {
        interruptInvokedAt: 10,
        stopInvokedAt: 12,
        stopReturnedAt: 15,
        bufferClearedAt: 16,
        inputResumedAt: 18,
      },
    },
  })
  assert.equal(result.realtime, 'STOPPED')
  assert.equal(result.interruptionLatency.interruptCallToStopMs, 2)
  assert.equal(result.interruptionLatency.stopCallDurationMs, 3)
  assert.equal(result.interruptionLatency.interruptCallToBufferClearMs, 6)
  assert.equal(result.interruptionLatency.inputResumeMs, 8)
  assert.equal(result.hardwareValidation.restartReconnect, 'UNVERIFIED')
  assert.equal(result.interruptionLatency.acousticStop, 'UNVERIFIED')
})

test('offline diagnostics provide evidence, monotonic observation time and next actions without passing physical hardware', () => {
  const result = diagnosticSnapshot({ modLoaded: true, clock: { now: () => 123 } })
  assert(result.checks.length >= 20 && result.checks.length <= 40)
  for (const check of result.checks) {
    assert(['PASS', 'FAIL', 'UNKNOWN', 'UNVERIFIED', 'NOT_TESTED'].includes(check.status))
    assert.equal(check.checkedAt.ticks, 123)
    for (const field of ['id', 'item', 'evidence', 'reason', 'nextStep']) assert.equal(typeof check[field], 'string')
  }
  assert.equal(result.checks.find((c) => c.id === 'mod.loaded').status, 'PASS')
  for (const check of result.checks.filter((c) => c.id.startsWith('hardware.')))
    assert.equal(check.status, 'UNVERIFIED')
})

test('diagnostics tolerate failing observers and repeated reads, never touch start/upload and redact secrets', () => {
  const secret = 'do-not-log-this-credential'
  const context = {
    modLoaded: true,
    clock: { now: () => 17 },
    companion: {
      wifi: {
        getStatus() {
          throw new Error(secret)
        },
      },
    },
    robot: {
      get audio() {
        throw new Error(secret)
      },
    },
    realtime: {
      lastError: secret,
      options: { token: secret },
      inputTurn: { id: 3, sequence: 5 },
      buffer: { bytes: 640, length: 1, maxBytes: 7680, slots: new Array(8) },
      timers: new Map(),
    },
    transport: {
      getDiagnostics() {
        throw new Error(secret)
      },
      connect() {
        assert.fail('no connection')
      },
    },
  }
  for (let i = 0; i < 3; i++) {
    const result = diagnosticSnapshot(context)
    assert.equal(result.wifi, 'UNKNOWN')
    assert.equal(result.queues.outputBytes, 640)
    assert.equal(result.queues.outputBacklogMs, 640 / 48)
    assert.equal(result.turns.input, 3)
    assert(!JSON.stringify(result).includes(secret))
  }
})

test('security diagnostics whitelist identity/time/bootstrap metadata without triggering setup or exposing credentials', () => {
  const marker = 'private-device-token'
  const result = diagnosticSnapshot({
    identity: {
      getDiagnostics: () => ({ configured: true, blocked: false, revision: 3, token: marker, storage: marker }),
    },
    time: {
      getDiagnostics: () => ({ readable: true, synchronized: true, trusted: false, pending: false, lastError: marker }),
    },
    bootstrap: {
      getDiagnostics: () => ({
        pending: false,
        configurationReady: true,
        audioStarted: false,
        channelOwned: false,
        stages: { config: 'PASS', secret: marker },
        code: marker,
      }),
      start: () => assert.fail('read-only'),
    },
  })
  assert.equal(JSON.stringify(result).includes(marker), false)
  assert.equal(result.security.time.synchronized, true)
  assert.equal(result.security.time.trusted, false)
  for (const row of result.checks.filter((c) => c.id.startsWith('hardware.'))) assert.equal(row.status, 'UNVERIFIED')
})
