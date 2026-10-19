import { RealtimeSession } from '../ai/realtime-session.js'
import { RealtimePresentation } from '../app/realtime-presentation.js'
import { MockAudioInput } from './mock-audio-input.js'
import { MockAudioOutput } from './mock-audio-output.js'
import { MockRealtimeServer } from './mock-realtime.js'
import { createMockRealtimeRuntime } from './mock-realtime-runtime.js'
import { Simulator } from './simulator.js'

// Additive sidecar: the Phase 2.5 Simulator and ESP32 Companion are unchanged.
export class RealtimeSimulator extends Simulator {
  constructor(options = {}) {
    super(options)
    this.voiceOptions = options
  }

  async start() {
    await super.start()
    try {
      this.realtimeServer = new MockRealtimeServer(this.server.server, this.voiceOptions.realtimeServer)
      this.realtimeRuntime = createMockRealtimeRuntime()
      this.audioInput = new MockAudioInput()
      this.audioOutput = new MockAudioOutput(this.voiceOptions.audioOutput)
      const logger = {
        debug: (line) => {
          if (this.config.debug.enabled) this.write(`[realtime] ${line}`)
        },
        error: (code) => this.write(`[realtime] ${code}`),
      }
      const presentation = new RealtimePresentation(this.companion, logger)
      this.realtime = new RealtimeSession({
        options: {
          ...this.config.realtime,
          url: `ws://127.0.0.1:${this.server.port}/api/realtime`,
          deviceId: this.config.server.deviceId,
          reconnect: { initialDelayMs: 50, maxDelayMs: 200, maxAttempts: 4 },
          ...this.voiceOptions.realtime,
        },
        runtime: this.realtimeRuntime,
        wifi: this.companion.wifi,
        input: this.audioInput,
        output: this.audioOutput,
        logger,
        onStatus: (status) => this.write(`[realtime] status=${status}`),
        onPhase: (phase) => {
          this.write(`[realtime] phase=${phase}`)
          // Connection/INTERRUPTED are system states, not new emotions.
          this.companion.state.transition(phase === 'INTERRUPTED' ? 'LISTENING' : phase)
        },
        onEmotion: (emotion) => presentation.emotion(emotion),
        onAction: (action) => presentation.action(action),
      })
      return this
    } catch (error) {
      await this.close()
      throw error
    }
  }

  async connectRealtime() {
    if (this.closed) return { ok: false, code: 'CLOSED' }
    if (!this.realtime.running) {
      if (this.companion.apiTest) return { ok: false, code: 'BUSY' }
      // The existing gate prevents the demo hold timer or HTTP tasks from
      // overriding streaming state. Resolve the lease before Companion.close.
      const lease = new Promise((resolve) => {
        this.releaseVoice = resolve
      })
      void this.companion.runTask(() => lease)
      this.realtime.start()
    }
    try {
      await this.waitFor(
        () => ['CONNECTED', 'ERROR'].includes(this.realtime.status),
        this.realtime.options.connectionTimeoutMs + 1000,
      )
      return { ok: this.realtime.status === 'CONNECTED', code: this.realtime.lastError }
    } catch {
      return { ok: false, code: 'REALTIME_NOT_READY' }
    }
  }

  async voice() {
    if (this.voiceTask) return { ok: false, code: 'BUSY' }
    this.voiceTask = this.performVoice().finally(() => {
      this.voiceTask = null
    })
    return this.voiceTask
  }

  async performVoice() {
    const connection = await this.connectRealtime()
    if (!connection.ok) return connection
    // Fixture server supplies activity hints; production does not infer speech
    // merely because a microphone emitted a (possibly silent) PCM chunk.
    if (!(await this.audioInput.utterance())) return { ok: false, code: 'INPUT_STOPPED' }
    this.realtime.commitInput()
    return { ok: true }
  }

  interrupt() {
    return this.realtime.interrupt()
  }

  async stopRealtime() {
    this.realtime?.stop()
    this.releaseVoice?.()
    this.releaseVoice = null
    await this.companion?.apiTest
    this.write('[realtime] stopped')
  }

  snapshot() {
    const base = super.snapshot()
    if (!this.realtime) return base
    return {
      ...base,
      realtime: this.realtime.status,
      voicePhase: this.realtime.phase,
      bufferedBytes: this.realtime.buffer.bytes,
      metrics: { ...this.realtime.metrics },
    }
  }

  close() {
    if (this.voiceClosing) return this.voiceClosing
    this.realtime?.dispose()
    this.releaseVoice?.()
    this.releaseVoice = null
    this.realtimeServer?.close()
    this.voiceClosing = (async () => {
      await super.close()
      await this.voiceTask
    })()
    return this.voiceClosing
  }
}
