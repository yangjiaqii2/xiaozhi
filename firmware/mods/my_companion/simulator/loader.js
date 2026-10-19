import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'))
const runtime = new URL('./runtime.js', import.meta.url).href
const native = {
  'face-state': new URL('../../host/modules/ui/state/face-state.ts', root).href,
  'network-state': new URL('../../host/modules/connectivity/network-state.ts', root).href,
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'pins/audioout' && context.parentURL?.endsWith('/hardware/audio-runtime.js'))
    return { url: 'companion-simulator:unavailable-audioout', shortCircuit: true }
  if (specifier === 'url' && context.parentURL?.endsWith('/ai/realtime-runtime.js'))
    return { url: 'companion-simulator:url', shortCircuit: true }
  if (specifier === 'timer' || specifier === 'time')
    return { url: `companion-simulator:${specifier}`, shortCircuit: true }
  if (Object.hasOwn(native, specifier)) return { url: native[specifier], shortCircuit: true }
  if (specifier.startsWith('my-companion/')) {
    const source = manifest.modules[specifier]
    if (!source) throw new Error(`Unknown Companion module: ${specifier}`)
    return { url: new URL(`${source}.js`, root).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('companion-simulator:')) {
    if (url.endsWith(':unavailable-audioout'))
      return {
        format: 'module',
        shortCircuit: true,
        source: "export default class { constructor() { throw new Error('NATIVE_AUDIO_UNAVAILABLE_IN_NODE') } }",
      }
    return {
      format: 'module',
      source: url.endsWith(':url')
        ? "export { URL as default } from 'node:url'"
        : `export { ${url.split(':')[1]} as default } from ${JSON.stringify(runtime)}`,
      shortCircuit: true,
    }
  }
  if (Object.values(native).includes(url)) {
    return { format: 'module', source: stripTypeScriptTypes(await readFile(new URL(url), 'utf8')), shortCircuit: true }
  }
  return nextLoad(url, context)
}
