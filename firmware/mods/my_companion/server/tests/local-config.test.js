import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { loadLocalConfig } from '../local-config-loader.js'

test('local server key loads without overriding an explicit environment value', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'companion-config-'))
  try {
    const url = pathToFileURL(join(dir, 'config.mjs'))
    await writeFile(url, "export default { APIYI_API_KEY: 'offline-test-marker' }")
    const env = {}
    await loadLocalConfig(env, url)
    assert.equal(env.APIYI_API_KEY, 'offline-test-marker')
    for (const value of ['', 'environment-marker']) {
      const explicit = { APIYI_API_KEY: value }
      await loadLocalConfig(explicit, url)
      assert.equal(explicit.APIYI_API_KEY, value)
    }
    const missing = {}
    await loadLocalConfig(missing, pathToFileURL(join(dir, 'missing.mjs')))
    assert.deepEqual(missing, {})
    const invalid = pathToFileURL(join(dir, 'invalid.mjs'))
    await writeFile(invalid, "throw new Error('secret-marker')")
    await assert.rejects(loadLocalConfig({}, invalid), { message: 'LOCAL_CONFIG_INVALID' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
