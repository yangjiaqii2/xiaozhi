import assert from 'node:assert/strict'
import test from 'node:test'
import { ActivityInput } from '../../ai/activity-input.js'
import { PCMActivity } from '../../ai/pcm-activity.js'

const tone = (samples = 320, amplitude = 5000) => {
  const pcm = new ArrayBuffer(samples * 2)
  const view = new DataView(pcm)
  for (let n = 0; n < samples; n++) view.setInt16(n * 2, Math.sin((n * Math.PI) / 8) * amplitude, true)
  return pcm
}
test('sample-based activity requires sustained signal, rejects silence, DC, quiet noise and isolated impulse', () => {
  const detector = new PCMActivity()
  assert.equal(detector.push(new ArrayBuffer(640)).triggered, false)
  const dc = new ArrayBuffer(1280)
  const view = new DataView(dc)
  for (let n = 0; n < 640; n++) view.setInt16(n * 2, 8000, true)
  assert.equal(detector.push(dc).triggered, false)
  assert.equal(detector.push(tone(640, 100)).triggered, false)
  const impulse = new ArrayBuffer(640)
  new DataView(impulse).setInt16(0, 30000, true)
  assert.equal(detector.push(impulse).triggered, false)
  detector.reset()
  assert.equal(detector.push(tone()).triggered, false)
  assert.equal(detector.push(tone()).triggered, true)
})
test('chunk boundaries do not change the sample activity threshold and memory stays bounded', () => {
  for (const samples of [80, 160, 320, 640]) {
    const detector = new PCMActivity()
    let count = 0
    while (!detector.push(tone(samples)).triggered) {
      count++
      assert(count < 8)
    }
    assert.equal((count + 1) * samples, 640)
  }
})
test('activity stops a real current turn before uploading the triggering chunk; no ACK, silence or end-of-utterance required', () => {
  const calls = []
  let callback
  let time = 0
  const raw = {
    start(fn) {
      callback = fn
    },
    stop() {
      calls.push('input-stop')
    },
    dispose() {},
  }
  const session = {
    phase: 'SPEAKING',
    sessionId: 's',
    requestId: 'r',
    responseTurn: { id: 1, begun: true },
    interrupt() {
      calls.push('stop-and-clear')
      this.responseTurn = null
      return true
    },
  }
  const input = new ActivityInput(raw, {
    getSession: () => session,
    now: () => time,
    onEvent: (event) => calls.push(event.type),
  })
  input.start(() => calls.push('upload'))
  input.start(() => assert.fail())
  callback(tone())
  time = 20
  callback(tone())
  callback(tone())
  assert.equal(calls.filter((x) => x === 'stop-and-clear').length, 1)
  assert(calls.indexOf('stop-and-clear') < calls.lastIndexOf('upload'))
  assert.equal(calls.includes('input-stop'), false)
  input.stop()
  callback(tone())
  assert.equal(calls.filter((x) => x === 'upload').length, 3)
  input.dispose()
  input.dispose()
})
test('no activity hint during listening; stopped callbacks and old response windows cannot leak into a new turn', () => {
  let callback
  let stopped = 0
  const raw = {
    start(fn) {
      callback = fn
    },
    stop() {},
    dispose() {},
  }
  const session = {
    phase: 'LISTENING',
    sessionId: 's',
    responseTurn: null,
    interrupt() {
      stopped++
      this.responseTurn = null
    },
  }
  const input = new ActivityInput(raw, {
    getSession: () => session,
    now: () => 0,
    onEvent() {
      throw new Error('observer failure')
    },
  })
  input.start(() => {})
  callback(tone(640))
  assert.equal(stopped, 0)
  session.phase = 'SPEAKING'
  session.responseTurn = { id: 1, begun: true }
  callback(tone())
  session.responseTurn = { id: 2, begun: true }
  callback(tone())
  assert.equal(stopped, 0)
  callback(tone())
  assert.equal(stopped, 1)
  input.dispose()
  callback(tone(640))
  assert.equal(stopped, 1)
})

test('invalid PCM and detector configurations fail closed without changing default thresholds', () => {
  for (const pcm of [null, new Uint8Array(640), new ArrayBuffer(0), new ArrayBuffer(3), new ArrayBuffer(4098)]) {
    assert.throws(() => new PCMActivity().push(pcm), /INVALID_AUDIO_CHUNK/)
  }
  for (const config of [{ rms: Infinity }, { rms: 0 }, { range: 0 }, { attackMs: 21 }, { attackMs: 201 }]) {
    assert.throws(() => new PCMActivity(config), /INVALID_ACTIVITY_CONFIG/)
  }
})

test('energy hint rejects quiet fan-like tone but can trigger on sustained keyboard-like noise or playback echo: it is not AEC or speech VAD', () => {
  const quiet = new PCMActivity()
  for (let n = 0; n < 40; n++) assert.equal(quiet.push(tone(320, 100)).triggered, false)
  // Deterministic broadband samples, not measured physical keyboard/fan recordings.
  const samples = new ArrayBuffer(1280)
  const view = new DataView(samples)
  for (let n = 0; n < 640; n++) view.setInt16(n * 2, (((n * 73) % 127) - 63) * 100, true)
  assert(new PCMActivity().push(samples).triggered)
  assert(new PCMActivity().push(tone(640)).triggered)
})
