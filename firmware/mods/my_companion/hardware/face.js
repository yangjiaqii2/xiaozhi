import { Emotion } from 'face-state'

const emotions = Object.freeze({
  neutral: Emotion.NEUTRAL,
  listening: Emotion.NEUTRAL,
  thinking: Emotion.DOUBTFUL,
  speaking: Emotion.HAPPY,
  happy: Emotion.HAPPY,
  sad: Emotion.SAD,
  angry: Emotion.ANGRY,
  caring: Emotion.HAPPY,
  excited: Emotion.HAPPY,
  surprised: Emotion.DOUBTFUL,
})

export class FaceController {
  constructor(face, logger) {
    this.face = face
    this.logger = logger
  }

  apply(emotion) {
    try {
      const native = Object.hasOwn(emotions, emotion) ? emotions[emotion] : Emotion.NEUTRAL
      this.face.setEmotion(native)
      this.logger.debug(`${emotion} native=${native}`)
    } catch (error) {
      this.logger.error(String(error))
    }
  }
}
