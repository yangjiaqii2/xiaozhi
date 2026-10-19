import { register } from 'node:module'

register('./node-loader.mjs', import.meta.url)
globalThis.trace = (message) => process.stdout.write(message)
await import('./companion-runtime/runtime.test.js')
