import Timer from 'timer'

// MOD-owned pose names translated exclusively to the host MotionCapability.
export class MotionController {
  constructor(motion, options, logger, onAction) {
    this.motion = motion
    this.options = options
    this.logger = logger
    this.onAction = onAction
    this.closed = false
    this.task = null
    this.pending = null
    this.timer = null
    this.wake = null
    const yaw = Math.max(0, Math.min(0.08, options.yawRadians))
    const pitch = Math.max(0, Math.min(0.06, options.pitchRadians))
    this.poses = {
      neutral: { y: 0, p: 0, r: 0 },
      look_left: { y: yaw, p: 0, r: 0 },
      look_right: { y: -yaw, p: 0, r: 0 },
      look_up: { y: 0, p: -pitch, r: 0 },
      look_down: { y: 0, p: pitch, r: 0 },
    }
  }

  request(action) {
    if (this.closed || !this.options.enabled || !Object.hasOwn(this.poses, action)) return
    // One command in flight and one latest intent; rapid input cannot grow a queue.
    if (this.task) {
      this.pending = action
      return
    }
    this.task = this.perform(action).then(() => {
      this.task = null
      const pending = this.pending
      this.pending = null
      if (pending !== null) this.request(pending)
    })
  }

  async perform(action) {
    this.onAction(action)
    this.logger.debug(action)
    try {
      this.motion.lookAway()
      await this.motion.setTorque(true)
      if (this.closed) return
      const seconds = Math.max(0.5, Math.min(1, this.options.durationSeconds))
      await this.motion.setPose({ rotation: this.poses[action] }, seconds)
      if (this.closed) return
      // setPose resolves on driver acknowledgement, not physical movement completion.
      await new Promise((resolve) => {
        this.wake = resolve
        this.timer = Timer.set(
          () => {
            this.timer = null
            this.wake = null
            resolve()
          },
          seconds * 1000 + 100,
        )
      })
    } catch (error) {
      this.logger.error(String(error))
    } finally {
      try {
        await this.motion.setTorque(false)
      } catch (error) {
        this.logger.error(`torque off: ${String(error)}`)
      }
      this.onAction('none')
    }
  }

  async close() {
    this.closed = true
    this.pending = null
    if (this.timer !== null) Timer.clear(this.timer)
    this.timer = null
    const wake = this.wake
    this.wake = null
    if (wake) wake()
    await this.task
  }
}
