import { Companion } from 'my-companion/companion'
import { createLogger } from 'my-companion/logger'
import { Conversation } from '../app/conversation.js'
import { simulatorConfig } from './config.js'
import { createMockHTTP } from './mock-http.js'
import { MockRobot } from './mock-robot.js'
import { MockServer } from './mock-server.js'
import { MockWiFi } from './mock-wifi.js'
import { MockPresentation } from './presentation.js'
import { time, timer } from './runtime.js'

export class Simulator {
  constructor(options = {}) {
    this.write = options.write ?? ((line) => console.log(line))
    this.config = simulatorConfig(options)
    this.server = new MockServer(this.config.mockServer)
    this.network = new MockWiFi()
    this.http = createMockHTTP()
    this.robot = new MockRobot({ write: this.write, ready: this.network.ready })
    this.closed = false
    this.closing = null
  }

  async start() {
    try {
      await this.server.start()
      this.config.server.baseUrl = this.server.baseUrl
      this.companion = new Companion(this.robot, this.config, {
        networkRuntime: this.network.runtime,
        httpRuntime: this.http,
      })
      this.network.attach(this.companion.wifi)
      const enter = this.companion.state.onEnter
      let previous = 'BOOT'
      this.companion.state.onEnter = (event) => {
        this.write(`[STATE] ${previous} → ${event.state}`)
        previous = event.state
        enter(event)
      }
      this.unsubscribe = this.companion.wifi.onStatusChanged((status) => this.write(`[WiFi] ${status}`))
      this.presentation = new MockPresentation(this.companion, this.write, this.config.speakingMs)
      this.conversation = new Conversation({
        api: this.companion.api,
        state: this.companion.state,
        presentation: this.presentation,
        options: this.config.conversation,
        timer,
        now: () => time.ticks,
        logger: createLogger('Conversation', this.config.debug.enabled),
      })
      this.companion.start()
      await this.waitFor(() => this.network.isConnected())
      this.write(
        `[MockServer] ${this.server.baseUrl} scenario=${this.server.scenario} latencyMs=${this.server.latencyMs}`,
      )
      return this
    } catch (error) {
      await this.close()
      throw error
    }
  }

  testServer() {
    if (this.closed) return Promise.resolve({ ok: false, code: 'CLOSED' })
    if (this.companion.apiTest) return Promise.resolve({ ok: false, code: 'BUSY' })
    // Drive the exact power-button path installed by Companion, not a separate client.
    this.robot.input.pressPower()
    return this.companion.apiTest
  }

  chat(text) {
    if (this.closed) return Promise.resolve({ ok: false, code: 'CLOSED' })
    if (this.companion.apiTest) return Promise.resolve({ ok: false, code: 'BUSY' })
    return this.companion.runTask(() => this.conversation.chat(text))
  }

  async toggleWiFi() {
    if (this.closed) return
    if (this.network.getStatus() !== 'DISCONNECTED') this.network.disconnect()
    else {
      this.network.connect()
      await this.waitFor(() => this.network.isConnected())
    }
  }

  snapshot() {
    return {
      deviceId: this.config.server.deviceId,
      wifi: this.network.getStatus(),
      state: this.companion.state.current,
      emotion: this.robot.face.emotion,
      persona: this.companion.persona.name,
    }
  }

  async waitFor(condition, timeoutMs = 2000) {
    const deadline = performance.now() + timeoutMs
    while (!condition()) {
      if (this.closed || performance.now() >= deadline) throw new Error('SIMULATOR_WAIT_TIMEOUT')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  close() {
    if (this.closing) return this.closing
    this.closed = true
    this.conversation?.close()
    this.closing = (async () => {
      try {
        await this.companion?.close()
      } finally {
        this.unsubscribe?.()
        this.network.close()
        for (const request of this.http.activeRequests) request.close()
        await this.server.close()
      }
    })()
    return this.closing
  }
}
