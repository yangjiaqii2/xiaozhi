import { readFile } from 'node:fs/promises'
import { serverEnvironment } from './config.js'
import { loadLocalConfig } from './local-config-loader.js'
import { AIServer } from './server.js'

let server
try {
  await loadLocalConfig()
  const options = serverEnvironment()
  if (process.env.AI_SERVER_TLS_CERT && process.env.AI_SERVER_TLS_KEY)
    options.tls = {
      cert: await readFile(process.env.AI_SERVER_TLS_CERT),
      key: await readFile(process.env.AI_SERVER_TLS_KEY),
    }
  server = new AIServer({ ...options, log: (record) => console.log(`[Server] ${JSON.stringify(record)}`) })
  await server.start()
  console.log(`[Server] listening port=${server.port} tls=${server.secure}`)
  const close = async () => {
    await server.close()
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
} catch {
  console.error('[Server] SERVER_START_FAILED: check device credentials, TLS and provider configuration')
  await server?.close()
  process.exitCode = 1
}
