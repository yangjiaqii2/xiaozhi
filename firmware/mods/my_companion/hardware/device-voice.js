import { ActivityInput } from 'my-companion/activity-input'
import { RealtimeSession } from 'my-companion/realtime-session'

// Lifecycle owner only. Readiness is external evidence, never manufactured here.
// Constructor/diagnostics/stop do not initialize audio or connect to a server.
export class DeviceVoice {
  constructor({
    options = {},
    runtime,
    wifi,
    createAudio,
    readiness = () => ({}),
    activity = false,
    logger = { debug() {}, error() {} },
    callbacks = {},
    acquire = () => () => {},
  } = {}) {
    Object.assign(this, { options, runtime, wifi, createAudio, readiness, activity, logger, callbacks, acquire })
    this.session = null
    this.disposed = false
    this.lastError = null
    this.release = null
    this.lastRelease = null
  }
  start({ confirmed = false } = {}) {
    const refuse = (code) => {
      this.lastError = code
      return { ok: false, code }
    }
    if (this.disposed) return refuse('DISPOSED')
    if (!confirmed) return refuse('EXPLICIT_START_REQUIRED')
    if (this.session?.running) return { ok: true }
    let ready
    try {
      ready = this.readiness()
    } catch {
      return refuse('READINESS_UNKNOWN')
    }
    if (ready?.timeTrusted !== true) return refuse('TIME_UNVERIFIED')
    if (ready?.duplexValidated !== true) return refuse('AUDIO_DUPLEX_UNVERIFIED')
    if (ready?.audioOwned !== true) return refuse('AUDIO_OWNERSHIP_UNVERIFIED')
    if (typeof this.options.url !== 'string' || !this.options.url.startsWith('wss://'))
      return refuse('INSECURE_TRANSPORT')
    this.stop()
    let audio
    try {
      this.release = this.acquire()
      audio = this.createAudio({ duplexValidated: true, input: { onError: (code) => this.session?.lost(code) } })
      const input = this.activity
        ? new ActivityInput(audio.input, {
            getSession: () => this.session,
            now: () => this.runtime.now(),
          })
        : audio.input
      this.session = new RealtimeSession({
        options: this.options,
        runtime: this.runtime,
        wifi: this.wifi,
        input,
        output: audio.output,
        logger: this.logger,
        onPhase: this.callbacks.onPhase,
        onStatus: this.callbacks.onStatus,
        onEmotion: this.callbacks.onEmotion,
        onAction: this.callbacks.onAction,
        onTextDelta: this.callbacks.onTextDelta,
      })
      this.session.start()
      if (this.session.status === 'ERROR') {
        this.stop()
        return refuse('VOICE_START_FAILED')
      }
      return { ok: true }
    } catch {
      if (this.session) this.stop()
      else {
        for (const resource of [audio?.input, audio?.output]) {
          try {
            resource?.dispose()
          } catch {}
        }
        this.releaseLease()
      }
      return refuse('VOICE_START_FAILED')
    }
  }
  releaseLease() {
    const release = this.release
    this.release = null
    try {
      release?.()
    } catch {
      this.lastError = 'VOICE_RELEASE_FAILED'
    }
  }
  interrupt() {
    return this.session?.interrupt() ?? false
  }
  stop() {
    const session = this.session
    this.session = null
    try {
      session?.dispose()
    } catch {
      this.lastError = 'VOICE_RELEASE_FAILED'
    } finally {
      if (session)
        this.lastRelease = {
          sessionTimers: session.timers.size,
          bufferBytes: session.buffer.bytes,
          socketOwned: session.client.transport !== null,
          nativeRelease: 'UNVERIFIED',
        }
      this.releaseLease()
    }
  }
  dispose() {
    if (this.disposed) return
    this.stop()
    this.disposed = true
  }
}
