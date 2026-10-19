import assert from 'node:assert/strict'
import test from 'node:test'
import { RealtimeSession } from '../../ai/realtime-session.js'
import { DeviceVoice } from '../../hardware/device-voice.js'
import { MockAudioInput } from '../mock-audio-input.js'
import { MockAudioOutput } from '../mock-audio-output.js'
import { MockRealtimeServer } from '../mock-realtime.js'
import { createMockRealtimeRuntime } from '../mock-realtime-runtime.js'
import { MockServer } from '../mock-server.js'

for (const [gate, code] of [
  ['timeTrusted', 'TIME_UNVERIFIED'],
  ['duplexValidated', 'AUDIO_DUPLEX_UNVERIFIED'],
  ['audioOwned', 'AUDIO_OWNERSHIP_UNVERIFIED'],
])
  test(`device voice refuses ${gate} before constructing audio or connecting`, () => {
    const readiness = { timeTrusted: true, duplexValidated: true, audioOwned: true }
    readiness[gate] = false
    const voice = new DeviceVoice({
      options: { url: 'wss://example.com/api/realtime', deviceId: 'robot-001' },
      readiness: () => readiness,
      createAudio() {
        assert.fail('no native initialization')
      },
      runtime: {
        connect() {
          assert.fail('no network')
        },
      },
    })
    assert.equal(voice.start({ confirmed: true }).code, code)
    assert.equal(voice.session, null)
    voice.dispose()
    voice.dispose()
  })
test('explicit start confirmation and secure endpoint are required, even if all hardware attestations are supplied', () => {
  const voice = new DeviceVoice({
    options: { url: 'ws://example.com/api/realtime' },
    readiness: () => ({ timeTrusted: true, duplexValidated: true, audioOwned: true }),
    createAudio() {
      assert.fail()
    },
  })
  assert.equal(voice.start().code, 'EXPLICIT_START_REQUIRED')
  assert.equal(voice.start({ confirmed: true }).code, 'INSECURE_TRANSPORT')
})
test('device owner composes existing Session, streams multiple rounds and releases owned resources on repeated stop/start', async () => {
  const server = await new MockServer({ port: 0 }).start()
  const upstream = new MockRealtimeServer(server.server, { firstAudioDelayMs: 0 })
  const runtime = createMockRealtimeRuntime()
  // Explicit offline transport adapter maps a production-shaped URL to the local fixture.
  const connect = runtime.connect
  runtime.connect = (_url, events, limits) => connect(`ws://127.0.0.1:${server.port}/api/realtime`, events, limits)
  const wifi = { isConnected: () => true, onStatusChanged: () => () => {} }
  let input, output, inputError
  const voice = new DeviceVoice({
    options: { url: 'wss://example.com/api/realtime', deviceId: 'robot-001' },
    runtime,
    wifi,
    readiness: () => ({ timeTrusted: true, duplexValidated: true, audioOwned: true }),
    createAudio: (options) => {
      inputError = options.input.onError
      input = new MockAudioInput()
      output = new MockAudioOutput()
      return { input, output }
    },
  })
  const wait = async (fn) => {
    const end = performance.now() + 3000
    while (!fn()) {
      assert(performance.now() < end)
      await new Promise((r) => setTimeout(r, 2))
    }
  }
  try {
    assert(voice.start({ confirmed: true }).ok)
    assert(voice.session instanceof RealtimeSession)
    const first = voice.session
    voice.start({ confirmed: true })
    assert.equal(voice.session, first)
    await wait(() => first.status === 'CONNECTED')
    for (let i = 0; i < 3; i++) {
      await input.utterance()
      first.commitInput()
      await wait(() => first.phase === 'IDLE')
    }
    assert(output.playedChunks >= 9)
    inputError('AUDIO_INPUT_ERROR')
    assert.equal(first.lastError, 'AUDIO_INPUT_ERROR')
    assert.equal(first.buffer.bytes, 0)
    assert.equal(input.onChunk, null)
    voice.stop()
    voice.stop()
    assert.equal(voice.lastRelease.sessionTimers, 0)
    assert.equal(voice.lastRelease.bufferBytes, 0)
    assert.equal(voice.lastRelease.socketOwned, false)
    assert.equal(voice.lastRelease.nativeRelease, 'UNVERIFIED')
    assert.equal(first.timers.size, 0)
    assert.equal(first.buffer.bytes, 0)
    assert.equal(input.onChunk, null)
    assert(voice.start({ confirmed: true }).ok)
    await wait(() => voice.session.status === 'CONNECTED')
    voice.dispose()
    voice.dispose()
    assert.equal(voice.start({ confirmed: true }).code, 'DISPOSED')
  } finally {
    voice.dispose()
    upstream.close()
    await server.close()
  }
})

test('failed Session startup releases adapters and a failing external lease exactly once without leaking raw errors', () => {
  let releases = 0,
    disposed = 0
  const voice = new DeviceVoice({
    options: { url: 'wss://example.com/api/realtime', deviceId: '' },
    readiness: () => ({ timeTrusted: true, duplexValidated: true, audioOwned: true }),
    acquire: () => () => {
      releases++
      throw new Error('private lease detail')
    },
    createAudio: () => ({
      input: {
        dispose() {
          disposed++
        },
        stop() {},
      },
      output: {
        dispose() {
          disposed++
        },
        stop() {},
      },
    }),
  })
  assert.equal(voice.start({ confirmed: true }).code, 'VOICE_START_FAILED')
  assert.equal(voice.session, null)
  assert.equal(voice.release, null)
  voice.stop()
  voice.stop()
  voice.dispose()
  assert.equal(releases, 1)
  assert.equal(disposed, 2)
})
