import { NetworkConnectionState as states } from 'network-state'
import { time, timer } from './runtime.js'

// Native-service double, underneath the *real* Phase 2 WiFiController.
// No actual Wi-Fi driver or network-manager is imported.
export class MockWiFi {
  constructor({ connectionDelayMs = 5 } = {}) {
    this.connectionDelayMs = connectionDelayMs
    this.available = true
    this.service = null
    this.controller = null
    this.stats = { starts: 0, stops: 0 }
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve
    })
    this.runtime = {
      get: () => this.service,
      start: () => this.startNative(),
      stop: () => this.stopNative(),
      states,
      timer,
      now: () => time.ticks,
      elapsed: (start, end) => time.delta(start, end),
      credentials: () => ({ ssid: 'simulator-only', password: '' }),
    }
  }

  attach(controller) {
    this.controller = controller
  }
  connect() {
    this.controller.connect()
  }
  disconnect() {
    this.controller.disconnect()
  }
  isConnected() {
    return this.controller.isConnected()
  }
  getStatus() {
    return this.controller.getStatus()
  }

  startNative() {
    if (this.service) throw new Error('DUPLICATE_MOCK_CONNECTION')
    this.stats.starts += 1
    const service = { state: states.CONNECTING, timer: null }
    this.service = service
    service.timer = setTimeout(() => {
      service.timer = null
      if (this.service !== service) return
      service.state = this.available ? states.CONNECTED : states.FAILED
      this.resolveReady({ status: this.available ? 'connected' : 'failed' })
    }, this.connectionDelayMs)
    return service
  }

  stopNative() {
    if (!this.service) return
    this.stats.stops += 1
    clearTimeout(this.service.timer)
    this.service.state = states.CLOSED
    this.service = null
  }

  setAvailable(available) {
    this.available = available
    if (!available && this.service?.state === states.CONNECTED) this.service.state = states.RECONNECTING
  }

  close() {
    this.controller?.close()
    this.stopNative()
  }
}
