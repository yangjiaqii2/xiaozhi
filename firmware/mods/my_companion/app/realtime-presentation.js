import { stateProfiles } from 'my-companion/state'

const emotions = new Set(Object.values(stateProfiles).map((profile) => profile.emotion))

// Uses existing controllers and their whitelists. Server strings never select
// arbitrary methods, poses, JavaScript or actuator parameters.
export class RealtimePresentation {
  constructor(companion, logger) {
    this.companion = companion
    this.logger = logger
  }

  emotion(value) {
    if (!emotions.has(value)) this.logger.debug('unknown emotion → fallback NEUTRAL')
    this.companion.face.apply(emotions.has(value) ? value : 'neutral')
  }

  action(value) {
    if (value === 'look_away') this.companion.motion.request('neutral')
    else if (value === 'look_around') {
      this.companion.motion.request('look_left')
      this.companion.motion.request('look_right')
    } else this.logger.debug('unknown action → ignored')
  }
}
