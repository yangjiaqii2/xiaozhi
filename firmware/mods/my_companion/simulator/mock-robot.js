import { EmotionNames } from 'face-state'

export class MockInput {
  constructor() {
    this.button = { power: {} }
  }
  pressPower() {
    this.button.power.onEvent?.({ kind: 'button', name: 'power', pressed: true, ticks: performance.now() >>> 0 })
    this.button.power.onEvent?.({ kind: 'button', name: 'power', pressed: false, ticks: performance.now() >>> 0 })
  }
}

export class MockFace {
  constructor(write) {
    this.write = write
    this.emotion = 'NEUTRAL'
  }
  setEmotion(value) {
    this.emotion = EmotionNames[value] ?? 'NEUTRAL'
    this.write(`[FACE] emotion=${this.emotion}`)
  }
}

export class MockMotion {
  constructor(write) {
    this.write = write
    this.torque = false
    this.gaze = null
    this.pose = { rotation: { y: 0, p: 0, r: 0 } }
  }
  lookAway() {
    this.gaze = null
    this.write('[MOTION] lookAway')
  }
  lookAt(point) {
    this.gaze = [...point]
    this.write(`[MOTION] lookAt=${JSON.stringify(point)}`)
  }
  async setTorque(value) {
    this.torque = value
    this.write(`[MOTION] torque=${value}`)
  }
  async setPose(pose) {
    this.pose = { rotation: { ...pose.rotation } }
    this.write(`[MOTION] pose=${JSON.stringify(pose.rotation)}`)
  }
}

export class MockRobot {
  constructor({ write, ready }) {
    this.face = new MockFace(write)
    this.motion = new MockMotion(write)
    this.input = new MockInput()
    this.connectivity = { network: { ready } }
    this.balloon = null
    this.drawer = new Map()
    this.ui = {
      showBalloon: (text) => {
        this.balloon = text
        write(`[UI] balloon=${JSON.stringify(text)}`)
      },
      hideBalloon: () => {
        this.balloon = null
        write('[UI] hide balloon')
      },
      closeDrawer() {},
      drawer: {
        addDrawerButton: (button) => this.drawer.set(button.key, button.callback),
        removeDrawerButton: (key) => this.drawer.delete(key),
      },
    }
  }
}
