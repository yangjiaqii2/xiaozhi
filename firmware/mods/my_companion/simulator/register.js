import { register } from 'node:module'

register('./loader.js', import.meta.url)
globalThis.trace ??= (message) => process.stdout.write(message)
