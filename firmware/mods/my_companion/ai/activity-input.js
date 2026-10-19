import { PCMActivity } from 'my-companion/pcm-activity'

// Opt-in input decorator: local playback never waits for upload or Provider VAD/ACK.
// Enable on physical devices only after echo/threshold validation by the owner.
export class ActivityInput {
  constructor(input, { getSession, now, onEvent = () => {}, detector = {} }) {
    this.input = input
    this.getSession = getSession
    this.now = now
    this.onEvent = onEvent
    this.detector = new PCMActivity(detector)
    this.active = false
    this.disposed = false
    this.epoch = 0
    this.key = null
    this.lastEvent = null
  }
  start(onChunk) {
    if (this.disposed) throw new Error('DISPOSED')
    if (this.active) return
    this.active = true
    const epoch = ++this.epoch
    try {
      this.input.start((pcm) => {
        if (!this.active || epoch !== this.epoch) return
        const session = this.getSession()
        const turn = session?.responseTurn
        const key = session?.phase === 'SPEAKING' && turn?.begun ? `${session.sessionId}:${turn.id}` : null
        if (key !== this.key || !key) {
          this.detector.reset()
          this.key = key
          this.firstAt = null
        }
        if (key) {
          const entered = this.now()
          const result = this.detector.push(pcm)
          if (!result.run && !result.triggered) this.firstAt = null
          if (result.candidate && this.firstAt == null) this.firstAt = entered
          if (result.triggered) {
            const detected = this.now()
            const event = {
              type: 'pcm_activity',
              requestId: session.requestId,
              sessionId: session.sessionId,
              turnId: turn.id,
              firstCandidateAt: this.firstAt,
              detectorEnteredAt: entered,
              detectedAt: detected,
            }
            session.interrupt()
            event.interruptReturnedAt = this.now()
            this.lastEvent = event
            try {
              this.onEvent(event)
            } catch {
              /* Telemetry cannot prevent stop or input forwarding. */
            }
          }
        }
        if (this.active && epoch === this.epoch) onChunk(pcm)
      })
    } catch (error) {
      this.active = false
      throw error
    }
  }
  stop() {
    ++this.epoch
    this.active = false
    this.key = null
    this.firstAt = null
    this.detector.reset()
    this.input.stop()
  }
  dispose() {
    if (this.disposed) return
    this.stop()
    this.disposed = true
    this.input.dispose()
    this.onEvent = () => {}
    this.getSession = () => null
  }
}
