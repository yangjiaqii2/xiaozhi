import { ApiClient } from 'my-companion/api-client'
import { FaceController } from 'my-companion/face'
import { createLogger } from 'my-companion/logger'
import { MotionController } from 'my-companion/motion'
import { loadPersona } from 'my-companion/persona'
import { validateDeviceConfig, validateHealthResponse } from 'my-companion/protocol'
import { CompanionState, State, stateOrder } from 'my-companion/state'
import { WiFiController, WiFiStatus } from 'my-companion/wifi'
import Time from 'time'
import Timer from 'timer'

export class Companion {
  constructor(robot, config, runtimes = {}) {
    this.robot = robot
    this.config = config
    this.persona = loadPersona(config.persona)
    this.logger = createLogger('Companion', config.debug.enabled)
    this.face = new FaceController(robot.face, createLogger('Face', config.debug.enabled))
    this.state = new CompanionState({
      now: () => Time.ticks,
      elapsed: (start, end) => Time.delta(start, end),
      holdMs: config.simulation.holdMs,
      onExit: ({ state, durationMs }) => this.logger.debug(`exit=${state} durationMs=${durationMs}`),
      onEnter: (event) => this.onEnter(event),
    })
    this.motion = new MotionController(
      robot.motion,
      config.motion,
      createLogger('Motion', config.debug.enabled),
      (action) => {
        this.state.currentAction = action
      },
    )
    this.timer = null
    this.bindings = []
    this.drawerKeys = []
    this.closed = false
    this.apiTest = null
    this.networkStatus = WiFiStatus.DISCONNECTED
    this.protocolLogger = createLogger('Protocol', config.debug.enabled)
    if (config.network.enabled) {
      this.wifi = new WiFiController(
        robot.connectivity?.network,
        config.network,
        runtimes.networkRuntime,
        createLogger('WiFi', config.debug.enabled),
      )
      this.unsubscribeWiFi = this.wifi.onStatusChanged((status) => {
        this.networkStatus = status
      })
      this.api = new ApiClient(
        config.server,
        this.wifi,
        runtimes.httpRuntime,
        createLogger('API', config.debug.enabled),
        createLogger('HTTP', config.debug.enabled),
      )
    }
  }

  start() {
    if (this.closed || this.timer !== null) return
    this.state.transition(State.IDLE)
    this.timer = Timer.repeat(() => {
      if (!this.apiTest) this.state.update()
    }, this.config.simulation.tickMs)
    this.wifi?.connect()
    this.bindButton('a', () => this.step(1))
    this.bindButton('b', () => this.step(-1))
    this.bindButton('c', () => this.select(State.IDLE))
    this.bindButton('power', () => {
      if (this.api) void this.testServer()
      else this.step(1)
    })
    if (this.api)
      this.addControl('test-server', 'Companion: test server', () => {
        void this.testServer()
      })
    this.addControl('next', 'Companion: next state', () => this.step(1))
    this.addControl('previous', 'Companion: previous state', () => this.step(-1))
    this.addControl('idle', 'Companion: idle', () => this.select(State.IDLE))
    this.addControl('stop', 'Companion: stop', () => {
      this.close().catch((error) => this.logger.error(`stop: ${String(error)}`))
    })
    this.logger.debug('ready; power=test server; SPEAKING does not play audio')
  }

  onEnter({ state, profile }) {
    if (this.closed) return
    this.logger.debug(`enter=${state} phase=${profile.phase}`)
    this.face.apply(profile.emotion)
    try {
      // ASCII labels use the existing host font, without adding font resources.
      this.robot.ui.showBalloon(`SIM: ${state}`)
    } catch (error) {
      this.logger.error(`display: ${String(error)}`)
    }
    this.motion.request(profile.action)
  }

  select(state) {
    if (!this.closed && !this.apiTest) this.state.transition(state)
  }

  testServer() {
    return this.runTask(() => this.performServerTest())
  }

  // Shared operation gate: keep rendering, reject state overrides, and retain one task.
  // The default ESP32 testServer path keeps its existing behavior.
  runTask(operation) {
    if (this.closed || !this.api) return Promise.resolve()
    if (this.apiTest) return this.apiTest
    this.apiTest = operation().finally(() => {
      this.apiTest = null
    })
    return this.apiTest
  }

  async performServerTest() {
    this.state.transition(State.THINKING)
    try {
      const response = await this.api.get(this.config.server.testPath)
      const kind = this.config.server.testProtocol
      if (kind === 'deviceConfig') {
        const data = validateDeviceConfig(response.data)
        if (this.config.server.deviceId && data.deviceId !== this.config.server.deviceId) {
          this.protocolLogger.error('DEVICE_ID_MISMATCH')
          return { ok: false }
        }
      } else if (kind === 'health') validateHealthResponse(response.data)
      else {
        this.protocolLogger.error('UNKNOWN_TEST_PROTOCOL')
        return { ok: false }
      }
      // Do not log server text, credentials, user data or the full JSON response.
      this.protocolLogger.debug(`${kind} valid requestId=${response.requestId}`)
      return { ok: true, status: response.status, requestId: response.requestId }
    } catch (error) {
      this.protocolLogger.error(error?.name === 'NetworkError' ? error.code : 'TEST_REQUEST_ERROR')
      return { ok: false }
    } finally {
      if (!this.closed) this.state.transition(State.IDLE)
    }
  }

  step(direction) {
    const index = stateOrder.indexOf(this.state.current)
    this.select(stateOrder[(index + direction + stateOrder.length) % stateOrder.length])
  }

  bindButton(name, action) {
    const button = this.robot.input.button?.[name]
    if (!button) return
    const previous = button.onEvent
    const handler = (event) => {
      if (event.pressed) action()
    }
    button.onEvent = handler
    this.bindings.push({ button, previous, handler })
    this.logger.debug(`input=${name}`)
  }

  addControl(name, label, action) {
    const key = `my-companion:${name}`
    this.robot.ui.drawer.addDrawerButton({
      key,
      label,
      callback: () => {
        this.robot.ui.closeDrawer()
        action()
      },
    })
    this.drawerKeys.push(key)
  }

  async close() {
    if (this.closed) return this.motion.close()
    this.closed = true
    this.api?.close()
    this.unsubscribeWiFi?.()
    this.wifi?.close()
    this.networkStatus = WiFiStatus.DISCONNECTED
    if (this.timer !== null) Timer.clear(this.timer)
    this.timer = null
    for (const { button, previous, handler } of this.bindings) {
      if (button.onEvent === handler) button.onEvent = previous
    }
    this.bindings.length = 0
    for (const key of this.drawerKeys) this.robot.ui.drawer.removeDrawerButton(key)
    this.drawerKeys.length = 0
    this.state.transition(State.IDLE)
    this.face.apply('neutral')
    this.robot.ui.hideBalloon()
    await this.motion.close()
    await this.apiTest
    this.logger.debug('stopped')
  }
}
