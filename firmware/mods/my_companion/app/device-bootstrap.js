import { validateDeviceConfig } from 'my-companion/protocol'

const codes = [
  'NETWORK_DISCONNECTED',
  'TIME_UNVERIFIED',
  'TIME_SYNC_TIMEOUT',
  'TIME_SYNC_ERROR',
  'DEVICE_UNAUTHORIZED',
  'CREDENTIAL_EXPIRED',
  'NONCE_UNAVAILABLE',
  'INSECURE_TRANSPORT',
  'INVALID_ENDPOINT',
  'TLS_OR_WEBSOCKET_ERROR',
  'WSS_UNAVAILABLE',
  'CONFIG_UNAVAILABLE',
  'INVALID_PROTOCOL',
  'BOOTSTRAP_TIMEOUT',
  'CANCELLED',
  'DISPOSED',
]
// Explicit setup only. No AudioIn/AudioOut, enrollment, provider fallback or retries.
export class DeviceBootstrap {
  constructor({ identity, wifi, time, timer, openChannel, timeoutMs = 10000 } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('INVALID_BOOTSTRAP_CONFIG')
    Object.assign(this, { identity, wifi, time, timer, openChannel, timeoutMs })
    this.stages = {}
    this.channel = null
    this.pending = null
    this.result = null
    this.disposed = false
    this.cancelStage = null
    this.epoch = 0
    this.unsubscribeIdentity = identity.onChange(() => this.stop())
    this.unsubscribeWiFi = wifi?.onStatusChanged?.((status) => {
      if (status !== 'CONNECTED') this.stop()
    })
  }
  start() {
    if (this.disposed) return Promise.resolve({ ok: false, code: 'DISPOSED' })
    if (this.pending) return this.pending
    if (this.result?.configurationReady) {
      try {
        if (!this.time.isTrusted()) throw new Error('TIME_UNVERIFIED')
        this.identity.assertUsable()
        return Promise.resolve(this.result)
      } catch {
        this.result = null
      }
    } else if (this.result) return Promise.resolve(this.result)
    this.stages = {}
    const epoch = this.epoch
    this.pending = this.run().then((result) => {
      if (epoch === this.epoch) this.result = result
      this.pending = null
      return result
    })
    return this.pending
  }
  async stage(name, task) {
    this.stages[name] = 'RUNNING'
    try {
      const result = await new Promise((resolve, reject) => {
        let settled = false
        const finish = (error, value) => {
          if (settled) return
          settled = true
          this.timer.clear(handle)
          this.cancelStage = null
          error ? reject(error) : resolve(value)
        }
        const handle = this.timer.set(() => finish(new Error('BOOTSTRAP_TIMEOUT')), this.timeoutMs)
        this.cancelStage = () => finish(new Error('CANCELLED'))
        Promise.resolve()
          .then(() => {
            if (!settled) return task()
          })
          .then(
            (v) => finish(null, v),
            (e) => finish(e),
          )
      })
      this.stages[name] = 'PASS'
      return result
    } catch (error) {
      this.stages[name] = 'FAIL'
      throw error
    }
  }
  async run() {
    try {
      await this.stage('network', () => {
        if (!this.wifi?.isConnected()) throw new Error('NETWORK_DISCONNECTED')
      })
      await this.stage('time', async () => {
        if (!this.time.isTrusted()) await this.time.sync?.()
        if (!this.time.isTrusted()) throw new Error(this.time.getDiagnostics?.().lastError ?? 'TIME_UNVERIFIED')
      })
      const credentials = await this.stage('credentials', () => this.identity.connectionCredentials())
      await this.stage('wss', async () => {
        this.channel = this.openChannel(credentials)
        await this.channel.ready
      })
      await this.stage('config', async () => {
        if (!this.channel.getConfig) throw new Error('CONFIG_UNAVAILABLE')
        const config = validateDeviceConfig(await this.channel.getConfig())
        if (config.deviceId !== credentials.deviceId) throw new Error('DEVICE_UNAUTHORIZED')
        // Features are data, never permission to start unverified audio hardware.
      })
      this.stages.audio = 'UNVERIFIED'
      return { ok: false, code: 'AUDIO_DUPLEX_UNVERIFIED', configurationReady: true }
    } catch (error) {
      const code = codes.includes(error?.code ?? error?.message) ? (error.code ?? error.message) : 'BOOTSTRAP_FAILED'
      if (code === 'DEVICE_UNAUTHORIZED') this.identity.reject()
      return { ok: false, code }
    } finally {
      this.time.stop?.()
      this.closeChannel()
    }
  }
  closeChannel() {
    const channel = this.channel
    this.channel = null
    try {
      channel?.close()
    } catch {}
  }
  stop() {
    this.epoch++
    this.cancelStage?.()
    this.time.stop?.()
    this.closeChannel()
    this.result = null
  }
  getDiagnostics() {
    return {
      stages: { ...this.stages },
      pending: !!this.pending,
      channelOwned: !!this.channel,
      code: this.result?.code ?? null,
      configurationReady: this.result?.configurationReady === true,
      audioStarted: false,
    }
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.stop()
    this.unsubscribeIdentity?.()
    this.unsubscribeWiFi?.()
  }
}
