// Node-only capability test adapter. It is excluded from the MOD manifest.
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'

const base = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('manifest.json', base), 'utf8'))
const adapters = {
  timer: `export default { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => { clearTimeout(id); clearInterval(id) }, repeat: (fn, ms) => setInterval(fn, ms) }`,
  time: `export default { get ticks() { return performance.now() >>> 0 }, delta: (start, end) => (end - start) >>> 0 }`,
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'companion-sdk-http') {
    if (!process.env.MODDABLE) throw new Error('Source xs-dev-export.sh before the SDK HTTP contract test')
    return { url: new URL(`file://${process.env.MODDABLE}/modules/network/http/http.js`).href, shortCircuit: true }
  }
  if (specifier === 'socket') {
    return { url: new URL('./helpers/sdk-socket.mjs', import.meta.url).href, shortCircuit: true }
  }
  if (adapters[specifier]) return { url: `companion-test:${specifier}`, shortCircuit: true }
  if (specifier.startsWith('my-companion/')) {
    return { url: new URL(`${manifest.modules[specifier]}.js`, base).href, shortCircuit: true }
  }
  if (specifier === 'face-state') {
    return { url: new URL('../../host/modules/ui/state/face-state.ts', base).href, shortCircuit: true }
  }
  if (specifier === 'testing/assert') {
    return { url: new URL('../../host/modules/testing/assert.js', base).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('companion-test:')) {
    return { format: 'module', source: adapters[url.slice(15)], shortCircuit: true }
  }
  if (url.endsWith('/face-state.ts')) {
    const source = stripTypeScriptTypes(await readFile(new URL(url), 'utf8'))
    return { format: 'module', source, shortCircuit: true }
  }
  return nextLoad(url, context)
}
