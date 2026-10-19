import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeAudio } from '../../ai/realtime-protocol.js'
import { OutputStream } from '../output-stream.js'

class Clock {
  constructor() {
    this.time = 0
    this.jobs = new Map()
    this.id = 0
  }
  now = () => this.time
  set = (fn, delay) => {
    const id = ++this.id
    this.jobs.set(id, { fn, at: this.time + delay })
    return id
  }
  clear = (id) => this.jobs.delete(id)
  advance(ms) {
    const end = this.time + ms
    let steps = 0
    while (this.jobs.size) {
      const [id, job] = [...this.jobs].sort((a, b) => a[1].at - b[1].at)[0]
      if (job.at > end) break
      assert(++steps < 100000)
      this.jobs.delete(id)
      this.time = job.at
      job.fn()
    }
    this.time = end
  }
}

test('slow wire is temporary, retains sequence/data, then resumes without expanding capacity', () => {
  const clock = new Clock()
  let writable = false
  const frames = []
  const errors = []
  const pressure = []
  const stream = new OutputStream({
    clock,
    canSend: () => writable,
    send: (frame) => frames.push(decodeAudio(frame, 2, 1920)),
    onPressure: (v) => pressure.push(v),
    onDrain() {},
    onError: (e) => errors.push(e),
    maxBytes: 3840,
    stallTimeoutMs: 1000,
  })
  stream.begin(1)
  stream.push(Buffer.alloc(2880, 7))
  clock.advance(200)
  assert.equal(frames.length, 0)
  assert.equal(stream.bytes, 2880)
  assert.equal(stream.sequence, 0)
  writable = true
  clock.advance(100)
  assert.equal(frames.length, 3)
  assert.equal(stream.bytes, 0)
  assert.deepEqual(errors, [])
  assert(pressure.includes(true) && pressure.includes(false))
  assert.deepEqual(
    frames.map((f) => f.sequence),
    [1, 2, 3],
  )
  stream.clear()
  assert.equal(clock.jobs.size, 0)
})

test('permanently blocked wire has a bounded timeout and releases timers/PCM', () => {
  const clock = new Clock()
  const errors = []
  const stream = new OutputStream({
    clock,
    canSend: () => false,
    send() {
      assert.fail()
    },
    onDrain() {},
    onError: (e) => errors.push(e),
    stallTimeoutMs: 100,
  })
  stream.begin(1)
  stream.push(Buffer.alloc(960))
  clock.advance(200)
  assert.deepEqual(errors, ['OUTPUT_CONSUMER_STALLED'])
  assert.equal(stream.bytes, 0)
  assert.equal(stream.timer, null)
  assert.equal(clock.jobs.size, 0)
})

test('long fast producer honors pressure and every byte is delivered across consecutive turns', () => {
  const clock = new Clock()
  let paused = false
  let produced = 0
  let received = 0
  let peak = 0
  let next = 1
  const errors = []
  const stream = new OutputStream({
    clock,
    send: (frame) => {
      const f = decodeAudio(frame, 2, 1920)
      assert.equal(f.sequence, next++)
      received += f.pcm.byteLength
    },
    onPressure: (v) => {
      paused = v
    },
    onDrain() {},
    onError: (e) => errors.push(e),
  })
  for (const turn of [1, 2, 3]) {
    next = 1
    stream.begin(turn)
    for (let n = 0; n < 100; ) {
      if (!paused) {
        stream.push(Buffer.alloc(15360))
        produced += 15360
        n++
        peak = Math.max(peak, stream.bytes)
      }
      clock.advance(5)
    }
    clock.advance(5000)
    assert.equal(stream.bytes, 0)
  }
  assert.equal(received, produced)
  assert(peak <= 192000)
  assert(stream.stats.pressureCount > 0)
  assert.deepEqual(errors, [])
  stream.clear()
  assert.equal(clock.jobs.size, 0)
})

test('cancel/connection loss during pressure clears old turn; new turn does not replay stale PCM', () => {
  const clock = new Clock()
  let writable = false
  const turns = []
  const stream = new OutputStream({
    clock,
    canSend: () => writable,
    send: (frame) => turns.push(decodeAudio(frame, 2, 1920).turnId),
    onDrain() {},
    onPressure() {},
    onError() {
      assert.fail()
    },
  })
  stream.begin(1)
  stream.push(Buffer.alloc(3840))
  clock.advance(30)
  stream.clear()
  clock.advance(100)
  writable = true
  stream.begin(2)
  stream.push(Buffer.alloc(1920))
  clock.advance(100)
  assert.deepEqual(turns, [2, 2])
  stream.clear()
  assert.equal(clock.jobs.size, 0)
})
