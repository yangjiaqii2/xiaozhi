import { createAudioRuntime } from 'my-companion/audio-runtime'
import { Companion } from 'my-companion/companion'
import config from 'my-companion/config'
import { DeviceBootstrap } from 'my-companion/device-bootstrap'
import { openDeviceChannel } from 'my-companion/device-channel'
import { DeviceIdentity } from 'my-companion/device-identity'
import { DeviceVoice } from 'my-companion/device-voice'
import { diagnosticSnapshot } from 'my-companion/diagnostics'
import httpRuntime from 'my-companion/http-runtime'
import { createLogger } from 'my-companion/logger'
import networkRuntime from 'my-companion/network-runtime'
import { RealtimePresentation } from 'my-companion/realtime-presentation'
import { createRealtimeRuntime } from 'my-companion/realtime-runtime'
import { createTimeRuntime } from 'my-companion/time-runtime'
import { TrustedTime } from 'my-companion/trusted-time'

let companion
let voice
let identity
let trustedTime
let bootstrap

// Local trusted provisioning adapter only; never called from server messages.
// No network enrollment or persistence is performed. A real secure provisioner is pending.
export function configureDevice(value, { confirmed = false, nonce } = {}) {
  if (!identity || !voice) return { ok: false, code: 'NOT_INITIALIZED' }
  if (!confirmed) return { ok: false, code: 'EXPLICIT_PROVISION_REQUIRED' }
  if (typeof value?.url !== 'string' || !/^wss:\/\/[^/@?#\s]+(?:\/[^#\s]*)?$/.test(value.url))
    return { ok: false, code: 'INVALID_ENDPOINT' }
  try {
    identity.provision(value.credentials, { confirmed: true })
    identity.nonce = nonce
    voice.options = { ...config.realtime, url: value.url, deviceId: value.credentials.deviceId }
    return { ok: true }
  } catch {
    return { ok: false, code: 'INVALID_CREDENTIALS' }
  }
}

export async function onContextCreated(robot) {
  voice?.dispose()
  if (companion) await companion.close()
  companion = new Companion(robot, config, { httpRuntime, networkRuntime })
  const timeRuntime = createTimeRuntime(config.bootstrap.timeHost)
  trustedTime = new TrustedTime({ runtime: timeRuntime, wifi: companion.wifi, timeoutMs: config.bootstrap.timeoutMs })
  identity = new DeviceIdentity({ isTimeTrusted: () => trustedTime.isTrusted() })
  const runtime = createRealtimeRuntime({
    isTimeTrusted: () => trustedTime.isTrusted(),
    deviceCredentials: () => identity.connectionCredentials(),
  })
  bootstrap = new DeviceBootstrap({
    identity,
    wifi: companion.wifi,
    time: trustedTime,
    timer: timeRuntime.timer,
    timeoutMs: config.bootstrap.timeoutMs,
    openChannel: () => openDeviceChannel({ runtime, url: voice.options.url, limits: voice.options }),
  })
  const logger = createLogger('realtime', config.debug.enabled)
  const presentation = new RealtimePresentation(companion, logger)
  voice = new DeviceVoice({
    options: config.realtime,
    runtime,
    wifi: companion.wifi,
    createAudio: (options) => createAudioRuntime(robot, options),
    // No authenticated time verifier, duplex proof or host-wide audio lease is installed.
    readiness: () => ({ timeTrusted: trustedTime.isTrusted() }),
    logger,
    acquire() {
      if (companion.apiTest) throw new Error('BUSY')
      let release
      const lease = new Promise((resolve) => {
        release = resolve
      })
      companion.runTask(() => lease)
      return release
    },
    callbacks: {
      onPhase: (phase) =>
        companion.state.transition(['IDLE', 'LISTENING', 'THINKING', 'SPEAKING'].includes(phase) ? phase : 'LISTENING'),
      onEmotion: (emotion) => presentation.emotion(emotion),
      onAction: (action) => presentation.action(action),
    },
  })
  const unsubscribeIdentity = identity.onChange(() => voice.stop())
  const close = companion.close.bind(companion)
  const ownedVoice = voice
  const ownedBootstrap = bootstrap
  const ownedIdentity = identity
  const ownedTime = trustedTime
  companion.close = async () => {
    ownedBootstrap.dispose()
    unsubscribeIdentity()
    ownedVoice.dispose()
    ownedIdentity.dispose()
    ownedTime.dispose()
    await close()
  }
  companion.start()
  companion.addControl('diagnostics', 'Companion: diagnostics (read only)', () => {
    const result = diagnosticSnapshot({
      robot,
      companion,
      voice,
      realtime: voice.session,
      transport: runtime,
      modLoaded: true,
      identity,
      time: trustedTime,
      bootstrap,
    })
    // Bound each log allocation; do not stringify one large report or any PCM.
    for (const check of result.checks) trace(`[Diagnostics] ${JSON.stringify(check)}\n`)
  })
  companion.addControl('bootstrap', 'Setup CHECK: network time + WSS config (no audio)', () => {
    void bootstrap.start().then((result) => logger.debug(`bootstrap=${result.code}`))
  })
  companion.addControl('bootstrap-stop', 'Setup STOP: cancel checks', () => bootstrap.stop())
  companion.addControl('voice-start', 'Voice START: mic + upload + playback', () => {
    if (!config.realtime.enabled) {
      logger.error('REALTIME_DISABLED')
      return
    }
    const result = voice.start({ confirmed: true })
    if (!result.ok) logger.error(result.code)
  })
  companion.addControl('voice-stop', 'Voice STOP: release audio + WSS', () => voice.stop())
  companion.addControl('voice-interrupt', 'Voice interrupt: stop playback', () => voice.interrupt())
}
