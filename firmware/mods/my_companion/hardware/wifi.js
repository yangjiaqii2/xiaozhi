export const WiFiStatus = Object.freeze({
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  RECONNECTING: 'RECONNECTING',
  ERROR: 'ERROR',
})

export class WiFiController {
  constructor(network, options, runtime, logger) {
    this.network = network
    this.options = options
    this.runtime = runtime
    this.logger = logger
    this.status = WiFiStatus.DISCONNECTED
    this.listeners = new Set()
    this.monitor = null
    this.retryTimer = null
    this.active = false
    this.closed = false
    this.everConnected = false
    this.owned = null
    this.observed = null
    this.nativeState = null
    this.changedAt = runtime.now()
    this.nextDelay = options.reconnect.initialDelayMs
  }

  connect() {
    if (this.closed || this.active) return
    const { pollMs, connectionTimeoutMs, reconnect } = this.options
    if (
      !Number.isInteger(pollMs) ||
      pollMs < 10 ||
      pollMs > 5000 ||
      !Number.isInteger(connectionTimeoutMs) ||
      connectionTimeoutMs < 1 ||
      connectionTimeoutMs > 120000 ||
      !Number.isInteger(reconnect.initialDelayMs) ||
      reconnect.initialDelayMs < 1 ||
      !Number.isInteger(reconnect.maxDelayMs) ||
      reconnect.maxDelayMs < reconnect.initialDelayMs ||
      reconnect.maxDelayMs > 60000
    ) {
      this.logger.error('INVALID_NETWORK_CONFIG')
      this.setStatus(WiFiStatus.ERROR)
      return
    }
    this.active = true
    this.everConnected = false
    this.nextDelay = this.options.reconnect.initialDelayMs
    this.setStatus(WiFiStatus.CONNECTING)
    this.monitor = this.runtime.timer.repeat(() => this.poll(), this.options.pollMs)
    // This is a boot result, not a live subscription. Never wait on it to render UI.
    this.network?.ready?.then(
      () => {
        if (this.active) this.poll()
      },
      () => {
        if (this.active) this.logger.error('BOOT_NETWORK_ERROR')
      },
    )
    if (this.runtime.get()) this.poll()
    else this.attempt()
  }

  getStatus() {
    return this.status
  }

  isConnected() {
    return (
      this.active && this.status === WiFiStatus.CONNECTED && this.runtime.get()?.state === this.runtime.states.CONNECTED
    )
  }

  onStatusChanged(listener) {
    if (this.listeners.size >= 8) throw new Error('WiFi subscriber limit')
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setStatus(status) {
    if (status === this.status) return
    this.status = status
    this.logger.debug(status)
    for (const listener of this.listeners) {
      try {
        listener(status)
      } catch {
        this.logger.error('STATUS_LISTENER_ERROR')
      }
    }
  }

  poll() {
    try {
      this.observe()
    } catch {
      this.logger.error('NETWORK_OBSERVATION_ERROR')
      this.setStatus(WiFiStatus.ERROR)
    }
  }

  observe() {
    if (!this.active) return
    const service = this.runtime.get()
    const native = service?.state
    const states = this.runtime.states
    if (service !== this.observed || native !== this.nativeState) {
      this.observed = service
      this.nativeState = native
      this.changedAt = this.runtime.now()
    }
    if (native === states.CONNECTED) {
      this.everConnected = true
      this.nextDelay = this.options.reconnect.initialDelayMs
      this.clearRetry()
      this.setStatus(WiFiStatus.CONNECTED)
      return
    }
    if (
      [states.CONNECTING, states.SCANNING, states.SYNCING_TIME].includes(native) &&
      this.runtime.elapsed(this.changedAt, this.runtime.now()) < this.options.connectionTimeoutMs
    ) {
      this.setStatus(this.everConnected ? WiFiStatus.RECONNECTING : WiFiStatus.CONNECTING)
      return
    }
    if (this.retryTimer !== null) return
    if (native === states.RECONNECTING) this.setStatus(WiFiStatus.RECONNECTING)
    else this.setStatus(WiFiStatus.ERROR)
    // Stop the failed/lost singleton, cancelling its fixed-delay native reconnect timer.
    if (service) this.stopService()
    this.owned = null
    this.scheduleRetry()
  }

  attempt() {
    if (!this.active) return
    try {
      const existing = this.runtime.get()
      if (existing && existing.state === this.runtime.states.CONNECTED) {
        this.poll()
        return
      }
      const credentials = this.credentials()
      if (!credentials.ssid) {
        this.setStatus(WiFiStatus.ERROR)
        return
      }
      if (existing && !this.stopService()) {
        this.scheduleRetry()
        return
      }
      this.setStatus(this.everConnected ? WiFiStatus.RECONNECTING : WiFiStatus.CONNECTING)
      this.owned = this.runtime.start({
        ...credentials,
        connectionTimeoutMs: this.options.connectionTimeoutMs,
        // The MOD observes loss and replaces the service before this native timer fires.
        reconnectDelayMs: this.options.reconnect.maxDelayMs + this.options.pollMs,
      })
      this.observed = this.owned
      this.nativeState = this.owned.state
      this.changedAt = this.runtime.now()
    } catch {
      this.logger.error('CONNECT_ERROR')
      if (this.runtime.get()) this.stopService()
      this.owned = null
      this.setStatus(WiFiStatus.ERROR)
      this.scheduleRetry()
    }
  }

  scheduleRetry() {
    if (!this.active || this.retryTimer !== null || !this.options.reconnect.enabled) return
    if (!this.credentials().ssid) {
      this.setStatus(WiFiStatus.ERROR)
      return
    }
    const delay = this.nextDelay
    this.nextDelay = Math.min(this.options.reconnect.maxDelayMs, delay * 2)
    this.setStatus(WiFiStatus.RECONNECTING)
    this.logger.debug(`retryDelayMs=${delay}`)
    this.retryTimer = this.runtime.timer.set(() => {
      this.retryTimer = null
      this.attempt()
    }, delay)
  }

  clearRetry() {
    if (this.retryTimer !== null) this.runtime.timer.clear(this.retryTimer)
    this.retryTimer = null
  }

  credentials() {
    try {
      return this.runtime.credentials()
    } catch {
      this.logger.error('WIFI_CONFIG_ERROR')
      return { ssid: '', password: '' }
    }
  }

  stopService() {
    try {
      this.runtime.stop()
      return true
    } catch {
      this.logger.error('NETWORK_STOP_ERROR')
      this.setStatus(WiFiStatus.ERROR)
      return false
    }
  }

  disconnect() {
    this.active = false
    this.clearRetry()
    if (this.monitor !== null) this.runtime.timer.clear(this.monitor)
    this.monitor = null
    const stopped = !this.runtime.get() || this.stopService()
    this.owned = null
    this.setStatus(stopped ? WiFiStatus.DISCONNECTED : WiFiStatus.ERROR)
  }

  close() {
    this.active = false
    this.closed = true
    this.clearRetry()
    if (this.monitor !== null) this.runtime.timer.clear(this.monitor)
    this.monitor = null
    // Leave an adopted healthy host service alive; release only a service we started.
    if (this.owned && this.runtime.get() === this.owned) this.stopService()
    this.owned = null
    this.setStatus(WiFiStatus.DISCONNECTED)
    this.listeners.clear()
  }
}
