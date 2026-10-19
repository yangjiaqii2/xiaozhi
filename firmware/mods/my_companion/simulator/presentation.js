import { NetworkError } from 'my-companion/network-errors'
import { stateProfiles } from 'my-companion/state'

const supportedEmotions = new Set(Object.values(stateProfiles).map((profile) => profile.emotion))

export class MockPresentation {
  constructor(companion, write, speakingMs) {
    if (!Number.isInteger(speakingMs) || speakingMs < 0 || speakingMs > 10000)
      throw new Error('INVALID_SPEAKING_DURATION')
    this.companion = companion
    this.write = write
    this.speakingMs = speakingMs
    this.cancel = null
    this.closed = false
  }

  async reply(reply) {
    if (this.closed) throw new NetworkError('CANCELLED')
    // Drain the existing state-entry pose work before the server's action takes
    // control. Otherwise a late default lookAway would overwrite look_around.
    while (this.companion.motion?.task) {
      await this.companion.motion.task
      if (this.closed) throw new NetworkError('CANCELLED')
    }
    if (!supportedEmotions.has(reply.emotion)) this.write('[FACE] unknown emotion → fallback NEUTRAL')
    this.companion.face.apply(reply.emotion)
    // Fixed dispatch, never dynamic property lookup/eval on an untrusted action string.
    if (reply.action === 'look_away') {
      this.write('[MOTION] look_away')
      this.companion.robot.motion.lookAway()
    } else if (reply.action === 'look_around') {
      this.write('[MOTION] look_around')
      this.companion.robot.motion.lookAt([0.6, 0.15, 0])
      this.companion.robot.motion.lookAt([0.6, -0.15, 0])
    } else this.write(`[MOTION] ignored action=${JSON.stringify(reply.action)}`)
    this.write(`[SPEAKING] ${JSON.stringify(reply.text)}`)
    this.write(`[VOICE] voiceId=${JSON.stringify(reply.voiceId)}`)
    // Only a bounded visual hold; this is not TTS or audio playback.
    await new Promise((resolve, reject) => {
      const id = setTimeout(() => {
        this.cancel = null
        resolve()
      }, this.speakingMs)
      this.cancel = () => {
        clearTimeout(id)
        this.cancel = null
        reject(new NetworkError('CANCELLED'))
      }
    })
  }

  close() {
    this.closed = true
    this.cancel?.()
  }
}
