import assert from 'node:assert/strict'
import test from 'node:test'
import { createRealtimeRuntime } from '../../ai/realtime-runtime.js'
import { AudioInput } from '../../hardware/audio-input.js'
import { AudioOutput } from '../../hardware/audio-output.js'
import { createAudioRuntime } from '../../hardware/audio-runtime.js'

test('real microphone adapter drains callback bytes in bounded streaming pieces and restores handler', () => {
  let starts = 0
  let stops = 0
  const previous = () => {}
  const mic = {
    onReadable: previous,
    start() {
      starts++
    },
    stop() {
      stops++
    },
  }
  const input = new AudioInput(mic, { maxChunkBytes: 640 })
  const chunks = []
  input.start((pcm) => chunks.push(pcm.byteLength))
  input.start(() => assert.fail('duplicate start'))
  mic.onReadable.call(
    { sampleRate: 16000, channels: 1, bitsPerSample: 16, read: (size) => new ArrayBuffer(size) },
    1920,
  )
  assert.deepEqual(chunks, [640, 640, 640])
  input.stop()
  input.stop()
  input.dispose()
  input.dispose()
  assert.equal(starts, 1)
  assert.equal(stops, 1)
  assert.equal(mic.onReadable, previous)
})

test('microphone rejects another owner, invalid format and releases input on failure', () => {
  const mic = { recording: true, start() {}, stop() {} }
  const errors = []
  const input = new AudioInput(mic, { onError: (code) => errors.push(code) })
  assert.throws(() => input.start(() => {}), /AUDIO_INPUT_BUSY/)
  mic.recording = false
  input.start(() => assert.fail('unexpected PCM'))
  mic.onReadable.call({ sampleRate: 44100 }, 100)
  assert.deepEqual(errors, ['UNSUPPORTED_AUDIO_FORMAT'])
  assert.equal(input.active, false)
})

test('real output adapter enqueues SharedArrayBuffer PCM and callback; stop flushes/closes immediately', () => {
  const calls = []
  class AudioOut {
    static Volume = 4
    static RawSamples = 5
    static Callback = 3
    static Flush = 2
    constructor(options) {
      this.options = options
    }
    enqueue(...args) {
      calls.push(args)
    }
    start() {
      calls.push('start')
    }
    stop() {
      calls.push('stop')
    }
    close() {
      calls.push('close')
    }
  }
  let completed = 0
  const output = new AudioOutput(AudioOut)
  output.write(new ArrayBuffer(960), () => completed++)
  const native = output.audio
  assert.equal(native.options.sampleRate, 24000)
  assert.equal(native.options.numChannels, 1)
  assert(calls.some((args) => args[1] === AudioOut.RawSamples && args[2] instanceof SharedArrayBuffer))
  assert.throws(() => output.write(new ArrayBuffer(960), () => {}), /AUDIO_OUTPUT_BUSY/)
  native.callback(output.generation)
  assert.equal(completed, 1)
  output.write(new ArrayBuffer(960), () => completed++)
  const cancelledId = output.generation
  output.stop()
  native.callback(cancelledId)
  assert.equal(completed, 1)
  assert(calls.includes('stop'))
  assert(calls.some((args) => args[1] === AudioOut.Flush))
  assert(calls.includes('close'))
  assert.equal(output.samples, null)
  output.dispose()
  output.dispose()
})

test('production adapter rejects plaintext, untrusted time and credentials in URL', () => {
  const runtime = createRealtimeRuntime()
  assert.throws(() => runtime.connect('ws://127.0.0.1/api/realtime', {}, {}), /INSECURE_TRANSPORT/)
  assert.throws(() => runtime.connect('wss://example.com/api/realtime', {}, {}), /TIME_UNVERIFIED/)
  assert.throws(() => runtime.connect('wss://user:password@example.com/api/realtime', {}, {}), /INVALID_ENDPOINT/)
})

test('production audio factory rejects unverified duplex before accessing hardware', () => {
  assert.throws(
    () =>
      createAudioRuntime({
        get audio() {
          return assert.fail('must fail before hardware access')
        },
      }),
    /AUDIO_DUPLEX_UNVERIFIED/,
  )
})

test('WSS source adapter enforces verify/TLS floor, bounded fragments, closes socket and owned DNS', (t) => {
  const prior = globalThis.device
  t.after(() => {
    globalThis.device = prior
  })
  let config
  let dnsClosed = 0
  let socketClosed = 0
  let dnsCallbacks
  class Resolver {
    resolve(options) {
      dnsCallbacks = options
    }
    close() {
      dnsClosed++
    }
  }
  class Socket {
    constructor(options) {
      config = options
      const resolver = new options.dns.io({})
      resolver.resolve({ onResolved: () => assert.fail('late DNS'), onError() {} })
    }
    close() {
      socketClosed++
    }
  }
  globalThis.device = { network: { wss: { io: Socket, dns: { io: Resolver }, socket: { io: class {} } } } }
  const runtime = createRealtimeRuntime({
    isTimeTrusted: () => true,
    deviceCredentials: () => ({ deviceId: 'robot-001', token: 'd'.repeat(32) }),
  })
  const errors = []
  const transport = runtime.connect(
    'wss://example.com/api/realtime',
    {
      open() {},
      message() {
        assert.fail('oversize must not decode')
      },
      error: (code) => errors.push(code),
      close() {},
    },
    { maxControlBytes: 2048, maxOutputChunkBytes: 1920 },
  )
  assert.equal(config.socket.tls.verify, true)
  assert.equal(config.socket.tls.host, 'example.com')
  assert.equal(config.socket.tls.minimumVersion, 'TLSv1.2')
  assert.deepEqual(config.headers, [
    ['X-Device-Id', 'robot-001'],
    ['Authorization', `Bearer ${'d'.repeat(32)}`],
  ])
  config.onReadable.call(
    {
      read() {
        assert.fail('size must be checked before read')
      },
    },
    9000,
    { binary: true },
  )
  assert.deepEqual(errors, ['TRANSPORT_MESSAGE_ERROR'])
  transport.close()
  transport.close()
  dnsCallbacks.onResolved('example.com', '127.0.0.1')
  assert.equal(dnsClosed, 1)
  assert.equal(socketClosed, 1)
})

test('WSS diagnostics never initiate connections or time requests; TLS error closes without fallback', (t) => {
  const prior = globalThis.device
  t.after(() => {
    globalThis.device = prior
  })
  const offline = createRealtimeRuntime({
    isTimeTrusted() {
      assert.fail('read-only diagnostics must not invoke a time service')
    },
  })
  assert.equal(offline.getDiagnostics().state, 'NOT_TESTED')
  let cfg,
    closed = 0,
    opened = 0
  class Socket {
    constructor(options) {
      cfg = options
    }
    close() {
      closed++
    }
  }
  globalThis.device = { network: { wss: { io: Socket, socket: { io: class {} }, dns: { io: class {} } } } }
  const runtime = createRealtimeRuntime({ isTimeTrusted: () => true, ca: 'private-ca-payload' })
  runtime.connect(
    'wss://example.com/api/realtime',
    {
      open() {
        opened++
      },
      error() {},
      close() {},
    },
    { maxControlBytes: 2048, maxOutputChunkBytes: 1920 },
  )
  cfg.onError()
  cfg.onWritable(1000)
  const result = runtime.getDiagnostics()
  assert.equal(result.verificationRequired, true)
  assert.equal(result.state, 'FAIL')
  assert.equal(result.socketOwned, false)
  assert.equal(result.lastError, 'TLS_OR_WEBSOCKET_ERROR')
  assert.equal(closed, 1)
  assert.equal(opened, 0)
  assert.equal(JSON.stringify(result).includes('private-ca'), false)
})
