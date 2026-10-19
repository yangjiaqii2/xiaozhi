import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import test from 'node:test'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const entry = new URL('../device-preflight.js', import.meta.url).pathname
const register = new URL('../register.js', import.meta.url).pathname

test('offline preflight is read only, exposes all hardware as unverified, and never prints inherited secrets', async () => {
  const marker = 'INHERITED_CREDENTIAL_SHOULD_NOT_APPEAR'
  const result = await exec(process.execPath, ['--import', register, entry], {
    env: { ...process.env, APIYI_API_KEY: marker, DEVICE_TOKEN: marker },
    timeout: 5000,
  })
  const report = JSON.parse(result.stdout)
  assert.equal(report.hardwareAcceptance, 'UNVERIFIED')
  assert.equal(report.audioStarted, false)
  assert.equal(report.uploadStarted, false)
  assert(report.checks.filter((v) => v.id.startsWith('hardware.')).every((v) => v.status === 'UNVERIFIED'))
  assert.equal(result.stdout.includes(marker), false)
})
test('preflight rejects a false claim of hardware acceptance and unknown flags', async () => {
  for (const [flag, code] of [
    ['--require-hardware', 2],
    ['--record', 1],
  ]) {
    await assert.rejects(
      exec(process.execPath, ['--import', register, entry, flag], { timeout: 5000 }),
      (e) => e.code === code,
    )
  }
})
