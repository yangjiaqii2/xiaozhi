import { ApiYiRealtimeProvider } from './providers/apiyi/apiyi-realtime-provider.js'
import { configFromEnvironment, modelConfig } from './providers/apiyi/model-config.js'

export function createProviderFactory(env = process.env) {
  if ((env.AI_REALTIME_PROVIDER ?? 'apiyi') !== 'apiyi') throw new Error('UNSUPPORTED_PROVIDER')
  const base = configFromEnvironment(env)
  return (device, onMetrics) =>
    new ApiYiRealtimeProvider({
      env,
      onMetrics,
      config: modelConfig(base.model, {
        ...base,
        instructions: device.instructions || base.instructions,
        voice: device.voiceId ?? base.voice,
      }),
    })
}

export function serverEnvironment(env = process.env) {
  let devices
  try {
    devices = JSON.parse(env.DEVICE_CREDENTIALS_JSON ?? 'null')
  } catch {
    throw new Error('INVALID_DEVICE_CONFIG')
  }
  return {
    devices,
    host: env.AI_SERVER_HOST ?? '127.0.0.1',
    port: Number(env.AI_SERVER_PORT ?? 8787),
    providerFactory: createProviderFactory(env),
  }
}
