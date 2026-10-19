import { gaProtocol } from './apiyi-ga-protocol.js'
import { omniProtocol } from './apiyi-omni-protocol.js'

export const ProtocolFamily = Object.freeze({ OMNI: 'omni', GA: 'ga' })
const families = Object.freeze({
  omni: { inputRate: 16000, outputRate: 24000, voice: 'Tina', protocol: omniProtocol },
  ga: { inputRate: 24000, outputRate: 24000, voice: 'marin', protocol: gaProtocol },
})
export const ProviderModelConfig = Object.freeze({
  'qwen3.5-omni-flash-realtime': 'omni',
  'qwen3.5-omni-plus-realtime': 'omni',
  'gpt-realtime-2.1-mini': 'ga',
  'gpt-realtime-2.1': 'ga',
})

export function modelConfig(model = 'qwen3.5-omni-flash-realtime', options = {}) {
  if (!Object.hasOwn(ProviderModelConfig, model)) throw new Error('UNSUPPORTED_MODEL')
  const family = ProviderModelConfig[model]
  const base = families[family]
  const config = {
    model,
    family,
    inputRate: base.inputRate,
    outputRate: base.outputRate,
    voice: base.voice,
    vad: 'semantic_vad',
    mode: 'audio',
    instructions: '',
    ...options,
  }
  if (
    !['server_vad', 'semantic_vad', 'manual'].includes(config.vad) ||
    (config.vadSilenceMs !== undefined &&
      (config.vad !== 'server_vad' ||
        !Number.isInteger(config.vadSilenceMs) ||
        config.vadSilenceMs < 100 ||
        config.vadSilenceMs > 2000)) ||
    !['text', 'audio'].includes(config.mode) ||
    typeof config.voice !== 'string' ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(config.voice) ||
    typeof config.instructions !== 'string' ||
    config.instructions.length > 8192 ||
    config.inputRate !== base.inputRate ||
    config.outputRate !== base.outputRate ||
    config.family !== family
  )
    throw new Error('INVALID_PROVIDER_CONFIG')
  return Object.freeze(config)
}

export function protocolFor(config) {
  return families[config.family].protocol
}

export function configFromEnvironment(env = process.env) {
  return modelConfig(env.AI_REALTIME_MODEL ?? env.APIYI_REALTIME_MODEL ?? env.REALTIME_MODEL, {
    ...(env.AI_REALTIME_VOICE ? { voice: env.AI_REALTIME_VOICE } : {}),
    vad: env.AI_REALTIME_VAD ?? 'semantic_vad',
    ...(env.AI_REALTIME_VAD_SILENCE_MS === undefined ? {} : { vadSilenceMs: Number(env.AI_REALTIME_VAD_SILENCE_MS) }),
    instructions: env.AI_REALTIME_INSTRUCTIONS ?? '',
  })
}
