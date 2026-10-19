// Linux acceptance watchdog. A cost ceiling is distinct from transport inactivity.
export class ProgressDeadline {
  constructor({ now = () => performance.now(), idleMs = 30000, budgetMs = 180000 } = {}) {
    if (
      !Number.isInteger(idleMs) ||
      idleMs < 1 ||
      idleMs > 60000 ||
      !Number.isInteger(budgetMs) ||
      budgetMs < idleMs ||
      budgetMs > 180000
    )
      throw new Error('INVALID_ACCEPTANCE_BUDGET')
    this.now = now
    this.idleMs = idleMs
    this.budgetMs = budgetMs
    this.startedAt = this.lastAt = now()
  }
  progress() {
    this.lastAt = this.now()
  }
  check() {
    const now = this.now()
    if (now - this.startedAt > this.budgetMs) return 'ACCEPTANCE_COST_BUDGET'
    if (now - this.lastAt > this.idleMs) return 'STREAM_STALLED'
    return null
  }
}

// lastError is diagnostic history; connection state/session identity define liveness.
export function activeSessionError(session, expectedSessionId) {
  if (session.status === 'CONNECTED' && session.sessionId === expectedSessionId) return null
  return session.lastError ?? 'SESSION_LOST'
}

// Test completion follows the last WAV utterance, not an earlier reply in the trial.
export class TurnCompletion {
  constructor() {
    this.completed = new Set()
    this.expected = null
    this.cancelled = new Set()
  }
  expect(sessionId, turnId) {
    this.expected = { sessionId, turnId }
  }
  complete(sessionId, turnId) {
    if (this.completed.size >= 64) throw new Error('METRIC_LIMIT')
    this.completed.add(`${sessionId}:${turnId}`)
  }
  cancel(sessionId, turnId) {
    if (this.cancelled.size >= 64) throw new Error('METRIC_LIMIT')
    const key = `${sessionId}:${turnId}`
    this.completed.delete(key)
    this.cancelled.add(key)
  }
  isComplete() {
    if (!this.expected) return false
    const { sessionId, turnId } = this.expected
    const key = `${sessionId}:${turnId}`
    if (this.completed.has(key)) return true
    // Delayed server VAD may split a still-uploading WAV into a later input turn.
    // Follow only an observed cancellation, in this session, into a completed successor.
    return (
      this.cancelled.has(key) &&
      [...this.completed].some((entry) => {
        const prefix = `${sessionId}:`
        return entry.startsWith(prefix) && Number(entry.slice(prefix.length)) > turnId
      })
    )
  }
}
