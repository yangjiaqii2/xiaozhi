import assert from 'node:assert/strict'
import test from 'node:test'
import { MockAudioOutput } from '../mock-audio-output.js'

test('default simulated speaker follows the sample clock instead of accumulating JS callback and file-write drift', (t) => {
  let time = 0
  const jobs = new Map()
  let serial = 0
  const clock = {
    now: () => time,
    set: (fn, delay) => {
      jobs.set(++serial, { fn, at: time + delay })
      return serial
    },
    clear: (id) => jobs.delete(id),
  }
  const output = new MockAudioOutput({ clock })
  t.after(() => output.dispose())
  let done = 0
  const write = () =>
    output.write(new ArrayBuffer(960), () => {
      done++
      time += 3 // PCM file/header bookkeeping between callbacks.
      if (done < 100) write()
    })
  write()
  assert.equal(jobs.size, 1)
  while (jobs.size) {
    const [id, job] = [...jobs][0]
    jobs.delete(id)
    time = job.at + 2 // Node event-loop delivery lateness.
    job.fn()
  }
  assert.equal(done, 100)
  assert(time <= 2005, `sample-clock drift: ${time - 2000}ms`)
  output.stop()
  assert.equal(output.nextAt, null)
})

test('explicit slow-consumer simulation retains its configured rate', (t) => {
  let delay
  const output = new MockAudioOutput({
    playbackMs: 200,
    clock: {
      now: () => 0,
      set: (_fn, ms) => {
        delay = ms
        return 1
      },
      clear() {},
    },
  })
  t.after(() => output.dispose())
  output.write(new ArrayBuffer(960), () => {})
  assert.equal(delay, 200)
})
