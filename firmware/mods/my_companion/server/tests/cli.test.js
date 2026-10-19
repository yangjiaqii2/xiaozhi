import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
test('live smoke commands with no key skip successfully without attempting a Provider', async () => {
  for (const mode of ['text', 'audio']) {
    const result = await exec(process.execPath, [fileURLToPath(new URL('../smoke.js', import.meta.url)), mode], {
      env: { ...process.env, APIYI_API_KEY: '' },
      timeout: 5000,
    })
    assert(result.stdout.includes('REAL PROVIDER TEST SKIPPED: APIYI_API_KEY not configured'))
  }
})

test('server startup validation never prints environment secrets', async () => {
  const marker = 'OFFLINE_ENV_CREDENTIAL_MARKER'
  let result
  try {
    await exec(process.execPath, [fileURLToPath(new URL('../index.js', import.meta.url))], {
      env: { ...process.env, APIYI_API_KEY: marker, DEVICE_CREDENTIALS_JSON: `{${marker}` },
      timeout: 5000,
    })
    assert.fail('must reject invalid configuration')
  } catch (error) {
    result = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  assert(result.includes('SERVER_START_FAILED'))
  assert.equal(result.includes(marker), false)
})
