import assert from 'node:assert/strict'
import test from 'node:test'
import { ProgressDeadline } from '../progress-deadline.js'

test('a continuously consumed long stream is not killed by the old fixed 60 second deadline', () => {
  let now = 0
  const watch = new ProgressDeadline({ now: () => now, idleMs: 30000, budgetMs: 180000 })
  for (now = 10000; now < 130000; now += 10000) {
    watch.progress()
    assert.equal(watch.check(), null)
  }
})
test('no progress expires the inactivity watchdog, while explicit cost budget stays finite', () => {
  let now = 0
  const watch = new ProgressDeadline({ now: () => now, idleMs: 30000, budgetMs: 180000 })
  now = 30001
  assert.equal(watch.check(), 'STREAM_STALLED')
  watch.progress()
  assert.equal(watch.check(), null)
  now = 180001
  watch.progress()
  assert.equal(watch.check(), 'ACCEPTANCE_COST_BUDGET')
})

test('a retained historical error cannot fail a healthy replacement session, but a new loss with the same code is detected', async () => {
  const { activeSessionError } = await import('../progress-deadline.js')
  const session = { status: 'CONNECTED', sessionId: 'new', lastError: 'PROVIDER_UNAVAILABLE' }
  assert.equal(activeSessionError(session, 'new'), null)
  session.status = 'RECONNECTING'
  assert.equal(activeSessionError(session, 'new'), 'PROVIDER_UNAVAILABLE')
  session.status = 'CONNECTED'
  session.sessionId = 'replacement'
  assert.equal(activeSessionError(session, 'new'), 'PROVIDER_UNAVAILABLE')
})

test('an earlier completed reply or another session cannot satisfy the final uploaded utterance', async () => {
  const { TurnCompletion } = await import('../progress-deadline.js')
  const tracker = new TurnCompletion()
  tracker.expect('session-A', 1)
  tracker.complete('session-A', 1)
  assert(tracker.isComplete())
  tracker.expect('session-A', 2)
  assert.equal(tracker.isComplete(), false)
  tracker.complete('session-A', 2)
  assert(tracker.isComplete())
  tracker.expect('session-B', 2)
  assert.equal(tracker.isComplete(), false)
  tracker.complete('session-B', 2)
  assert(tracker.isComplete())
})

test('a final upload overlapping an old response follows its explicit cancellation into a later response in the same session', async () => {
  const { TurnCompletion } = await import('../progress-deadline.js')
  const tracker = new TurnCompletion()
  tracker.expect('s', 2)
  tracker.complete('s', 1)
  assert.equal(tracker.isComplete(), false)
  tracker.cancel('s', 2)
  assert.equal(tracker.isComplete(), false)
  tracker.complete('other', 3)
  assert.equal(tracker.isComplete(), false)
  tracker.complete('s', 3)
  assert(tracker.isComplete())
  tracker.cancel('s', 3)
  assert.equal(tracker.isComplete(), false)
})
