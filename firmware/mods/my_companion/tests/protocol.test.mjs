import assert from 'node:assert/strict'
import test from 'node:test'
import { parseJSON, validateDeviceConfig, validateHealthResponse } from 'my-companion/protocol'

test('DeviceConfig retains validated fields without applying persona or unknown fields', () => {
  const result = validateDeviceConfig(
    parseJSON('{"deviceId":"robot-001","persona":{"name":"小七"},"features":{"vision":true},"unknown":"ignored"}'),
  )
  assert.deepEqual(result, { deviceId: 'robot-001', persona: { name: '小七' }, features: { vision: true } })
})

for (const value of [
  null,
  [],
  {},
  { deviceId: 12 },
  { deviceId: '' },
  { deviceId: 'x'.repeat(65) },
  { deviceId: 'r', persona: [] },
  { deviceId: 'r', persona: { name: 7 } },
  { deviceId: 'r', features: { vision: 'true' } },
]) {
  test(`reject invalid DeviceConfig ${JSON.stringify(value)}`, () => {
    assert.throws(() => validateDeviceConfig(value), { code: 'INVALID_PROTOCOL' })
  })
}

test('malformed JSON and invalid health status are classified', () => {
  assert.throws(() => parseJSON('{broken'), { code: 'INVALID_JSON' })
  assert.deepEqual(validateHealthResponse({ status: 'ok' }), { status: 'ok' })
  for (const value of [{}, { status: 200 }, { status: 'unknown' }]) {
    assert.throws(() => validateHealthResponse(value), { code: 'INVALID_PROTOCOL' })
  }
})
