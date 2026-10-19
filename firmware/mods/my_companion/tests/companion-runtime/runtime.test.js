import { Emotion } from 'face-state'
import { Companion } from 'my-companion/companion'
import config from 'my-companion/config'
import { MotionController } from 'my-companion/motion'
import { State, stateOrder } from 'my-companion/state'
import { assert, equal } from 'testing/assert'
import Timer from 'timer'

const wait = (ms) => new Promise((resolve) => Timer.set(resolve, ms))
const logger = { debug() {}, error() {} }

async function run() {
  const buttons = new Map()
  const prior = () => {}
  let nativeEmotion
  let text
  const robot = {
    input: { button: { power: { onEvent: prior } } },
    face: {
      setEmotion(value) {
        nativeEmotion = value
      },
    },
    motion: { lookAway() {}, async setTorque() {}, async setPose() {} },
    ui: {
      drawer: {
        addDrawerButton(spec) {
          buttons.set(spec.key, spec.callback)
        },
        removeDrawerButton(key) {
          buttons.delete(key)
        },
      },
      showBalloon(value) {
        text = value
      },
      hideBalloon() {
        text = null
      },
      closeDrawer() {},
    },
  }
  const companion = new Companion(robot, {
    ...config,
    debug: { enabled: false },
    network: { ...config.network, enabled: false },
    motion: { ...config.motion, enabled: false },
    simulation: { holdMs: 30, tickMs: 5 },
  })
  companion.start()
  equal(buttons.size, 4, 'drawer controls must register through the callback-capable facade')
  robot.input.button.power.onEvent({ pressed: false })
  equal(companion.state.current, State.IDLE, 'release must not change state')
  robot.input.button.power.onEvent({ pressed: true })
  equal(companion.state.current, State.LISTENING, 'CoreS3 power input advances state without ABC buttons')
  buttons.get('my-companion:next')()
  equal(companion.state.current, State.THINKING, 'drawer advances the same state machine')
  equal(nativeEmotion, Emotion.DOUBTFUL, 'thinking uses the real native enum')
  equal(text, 'SIM: THINKING', 'display reflects simulation state')
  for (const state of stateOrder) companion.select(state)
  assert(Number.isInteger(nativeEmotion), 'logical states must map to native expressions')
  await wait(80)
  equal(companion.state.current, State.IDLE, 'real Timer/Time must expire to idle')
  await companion.close()
  equal(buttons.size, 0, 'close removes all MOD drawer controls')
  equal(robot.input.button.power.onEvent, prior, 'close restores the previous input handler')
  equal(nativeEmotion, Emotion.NEUTRAL, 'close restores a neutral face')
  equal(text, null, 'close removes balloon')
  await companion.close()

  // Capability doubles verify ordering/failure handling; no physical servo claim.
  const poses = []
  const torque = []
  let active = 0
  const motion = new MotionController(
    {
      lookAway() {},
      async setTorque(value) {
        torque.push(value)
        active += value ? 1 : -1
        assert(active <= 1, 'servo requests must be serialized')
      },
      async setPose(pose) {
        poses.push(pose.rotation)
      },
    },
    config.motion,
    logger,
    () => {},
  )
  motion.request('look_left')
  motion.request('look_up')
  motion.request('look_down')
  await wait(1400)
  equal(poses.length, 2, 'only first and latest intent should execute')
  equal(poses[1].p, config.motion.pitchRadians, 'latest downward intent wins')
  equal(active, 0, 'torque must be released after completion')
  motion.request('look_right')
  await wait(20)
  await motion.close()
  equal(active, 0, 'close during motion must release torque')
  equal(torque[torque.length - 1], false, 'last hardware command releases torque')

  let failures = 0
  let released = false
  const broken = new MotionController(
    {
      lookAway() {},
      async setTorque(value) {
        if (!value) released = true
      },
      async setPose() {
        throw new Error('servo unavailable')
      },
    },
    config.motion,
    {
      debug() {},
      error() {
        failures += 1
      },
    },
    () => {},
  )
  broken.request('neutral')
  await wait(20)
  await broken.close()
  equal(failures, 1, 'driver failures are logged without an unhandled rejection')
  assert(released, 'driver failure still attempts torque release')
  trace('ok\n')
}

run().catch((error) => {
  trace(`companion runtime failed: ${error}\n`)
  throw error
})
