import { existsSync } from 'node:fs'

// An explicitly supplied environment value (including '') overrides local configuration.
export async function loadLocalConfig(env = process.env, url = new URL('./local-config.js', import.meta.url)) {
  if (env.APIYI_API_KEY !== undefined || !existsSync(url)) return
  try {
    const { default: config } = await import(url.href)
    if (!config || typeof config.APIYI_API_KEY !== 'string') throw new Error()
    env.APIYI_API_KEY = config.APIYI_API_KEY
  } catch {
    // Never print import errors: syntax errors can contain the line holding a secret.
    throw new Error('LOCAL_CONFIG_INVALID')
  }
}
