export const State = Object.freeze({
  IDLE: 'IDLE',
  LISTENING: 'LISTENING',
  THINKING: 'THINKING',
  SPEAKING: 'SPEAKING',
  HAPPY: 'HAPPY',
  SAD: 'SAD',
  ANGRY: 'ANGRY',
  CARING: 'CARING',
  EXCITED: 'EXCITED',
  SURPRISED: 'SURPRISED',
})

// Local display/action policy; this table does not infer user emotion.
export const stateProfiles = Object.freeze({
  IDLE: { emotion: 'neutral', action: 'neutral', phase: 'idle' },
  LISTENING: { emotion: 'listening', action: 'look_left', phase: 'listening' },
  THINKING: { emotion: 'thinking', action: 'look_up', phase: 'thinking' },
  SPEAKING: { emotion: 'speaking', action: 'neutral', phase: 'speaking' },
  HAPPY: { emotion: 'happy', action: 'look_right', phase: 'responding' },
  SAD: { emotion: 'sad', action: 'look_down', phase: 'responding' },
  ANGRY: { emotion: 'angry', action: 'neutral', phase: 'responding' },
  CARING: { emotion: 'caring', action: 'look_down', phase: 'responding' },
  EXCITED: { emotion: 'excited', action: 'look_right', phase: 'responding' },
  SURPRISED: { emotion: 'surprised', action: 'look_up', phase: 'responding' },
})
export const stateOrder = Object.freeze(Object.keys(State))

export class CompanionState {
  constructor({ now, elapsed, holdMs, onEnter = () => {}, onExit = () => {} }) {
    this.now = now
    this.elapsed = elapsed
    this.holdMs = holdMs
    this.onEnter = onEnter
    this.onExit = onExit
    this.current = null
    this.enteredAt = now()
    this.currentAction = 'none'
    this.phase = 'idle'
    this.changing = false
  }

  get durationMs() {
    return this.elapsed(this.enteredAt, this.now())
  }

  transition(next) {
    if (this.changing || !stateOrder.includes(next) || next === this.current) return false
    this.changing = true
    try {
      if (this.current !== null) this.onExit({ state: this.current, durationMs: this.durationMs })
      this.current = next
      this.enteredAt = this.now()
      this.phase = stateProfiles[next].phase
      this.onEnter({ state: next, profile: stateProfiles[next] })
      return true
    } finally {
      this.changing = false
    }
  }

  update() {
    if (this.current !== null && this.current !== State.IDLE && this.durationMs >= this.holdMs) {
      this.transition(State.IDLE)
    }
  }
}
