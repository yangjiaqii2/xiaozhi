import assert from 'node:assert/strict'
import test from 'node:test'
import { RealtimeSession } from '../../ai/realtime-session.js'

test('interrupt invalidates playback before stopping output; clears PCM even if native stop fails', () => {
  let session
  let stopped = false
  const calls = []
  session = new RealtimeSession({
    options: { deviceId: 'unit' },
    runtime: { timer: { clear() {} }, now: () => performance.now() },
    wifi: {},
    input: {},
    output: {
      stop() {
        assert(session.playEpoch > 0)
        assert.equal(session.buffer.bytes, 960)
        stopped = true
        calls.push('stop')
        throw new Error('NATIVE_STOP_FAILED')
      },
    },
  })
  session.running = true
  session.status = 'CONNECTED'
  session.responseTurn = { id: 1, begun: true }
  session.buffer.push(new ArrayBuffer(960))
  session.client.transport = {
    send() {
      assert(stopped)
      calls.push('cancel')
    },
  }
  assert.throws(() => session.interrupt(), /NATIVE_STOP_FAILED/)
  assert.equal(session.buffer.bytes, 0)
  assert.equal(session.responseTurn, null)
  assert.equal(stopped, true)
  assert.deepEqual(calls, ['stop'])
})
