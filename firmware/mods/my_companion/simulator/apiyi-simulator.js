import { randomBytes } from 'node:crypto'
import { ActivityInput } from '../ai/activity-input.js'
import { RealtimeSession } from '../ai/realtime-session.js'
import { createProviderFactory } from '../server/config.js'
import { createDeviceRuntime } from '../server/node-runtime.js'
import { AIServer } from '../server/server.js'
import { WavAudioInput, WavAudioOutput } from '../server/wav.js'
import { RealtimeSimulator } from './realtime-simulator.js'

// Explicit opt-in only. The default simulator still loads no ws/provider package.
export class ApiYiSimulator extends RealtimeSimulator {
  async start() {
    await super.start()
    try {
      const previous = this.realtime
      const { onPhase, onStatus, onEmotion, onAction, logger } = previous
      previous.dispose()
      this.realtimeServer.close()
      const token = randomBytes(32).toString('hex')
      const deviceId = this.config.server.deviceId
      this.aiServer = new AIServer({
        port: 0,
        maxRetries: 0,
        devices: [{ deviceId, tokens: [token] }],
        providerFactory: createProviderFactory(),
        log: (record) => this.write(`[Server] ${JSON.stringify(record)}`),
      })
      await this.aiServer.start()
      this.realtimeRuntime = createDeviceRuntime(() => ({ deviceId, token }))
      this.audioInput = new WavAudioInput(process.env.REALTIME_WAV)
      const output = process.env.REALTIME_OUTPUT_WAV ?? `/tmp/companion-${process.pid}-${Date.now()}.wav`
      this.audioOutput = new WavAudioOutput(output)
      const activityMode = this.voiceOptions.activityMode ?? process.env.REALTIME_ACTIVITY_HINT ?? 'provider'
      if (!['provider', 'pcm'].includes(activityMode)) throw new Error('INVALID_ACTIVITY_MODE')
      const input =
        activityMode === 'pcm'
          ? new ActivityInput(this.audioInput, {
              getSession: () => this.realtime,
              now: () => this.realtimeRuntime.now(),
              onEvent: (event) => this.voiceOptions.onActivity?.(event),
            })
          : this.audioInput
      this.realtime = new RealtimeSession({
        options: {
          ...previous.options,
          url: this.aiServer.url,
          connectionTimeoutMs: 35000,
          responseTimeoutMs: 30000,
          reconnect: { initialDelayMs: 1000, maxDelayMs: 2000, maxAttempts: 2 },
        },
        runtime: this.realtimeRuntime,
        wifi: this.companion.wifi,
        input,
        output: this.audioOutput,
        onPhase,
        onStatus,
        onEmotion,
        onAction,
        logger,
      })
      this.write(`[Provider] mode=apiyi output=${output}; v requires REALTIME_WAV (16k mono PCM16); no microphone`)
      return this
    } catch (error) {
      await this.close()
      throw error
    }
  }
  async performVoice() {
    if (!process.env.REALTIME_WAV) return { ok: false, code: 'REALTIME_WAV_REQUIRED' }
    this.audioInput.validate()
    const result = await this.connectRealtime()
    if (!result.ok) return result
    // Default Provider VAD commits. Manual commit is an explicit PTT/test mode.
    const manual = process.env.AI_REALTIME_VAD === 'manual'
    if (!(await this.audioInput.utterance({ silenceMs: manual ? 0 : 2000 })))
      return { ok: false, code: 'INPUT_STOPPED' }
    if (manual && !this.realtime.commitInput()) return { ok: false, code: 'INPUT_NOT_COMMITTED' }
    return { ok: true }
  }
  async close() {
    this.realtime?.dispose()
    await this.aiServer?.close()
    await super.close()
  }
}
