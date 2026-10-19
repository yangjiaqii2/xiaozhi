import assert from 'node:assert/strict'
import test from 'node:test'
import { validateChatRequest, validateChatResponse } from '../../ai/protocol.js'

const request = { deviceId: 'robot-001', requestId: 'chat-001', text: '你好' }
const response = {
  requestId: 'chat-001',
  reply: { text: '你好呀。', emotion: 'happy', action: 'look_around', voiceId: 'default' },
}

test('chat request and response retain only validated fields and correlate requestId', () => {
  assert.deepEqual(validateChatRequest({ ...request, secret: 'ignored' }), request)
  assert.deepEqual(validateChatResponse(response, request.requestId), response)
  assert.throws(() => validateChatResponse(response, 'other-request'), { code: 'INVALID_PROTOCOL' })
})

for (const field of ['deviceId', 'requestId', 'text']) {
  for (const bad of [undefined, null, 42, {}, [], '', ' '.repeat(4), 'x'.repeat(2049)]) {
    test(`reject invalid request ${field}=${typeof bad}`, () => {
      assert.throws(() => validateChatRequest({ ...request, [field]: bad }), { code: 'INVALID_PROTOCOL' })
    })
  }
}

test('response requires requestId and reply object', () => {
  for (const bad of [
    null,
    [],
    {},
    { ...response, requestId: 1 },
    { ...response, reply: null },
    { ...response, reply: [] },
  ]) {
    assert.throws(() => validateChatResponse(bad), { code: 'INVALID_PROTOCOL' })
  }
})

for (const field of ['text', 'emotion', 'action', 'voiceId']) {
  test(`response requires bounded string reply.${field}`, () => {
    for (const bad of [undefined, null, 42, [], {}, '', 'x'.repeat(4097)]) {
      assert.throws(() => validateChatResponse({ ...response, reply: { ...response.reply, [field]: bad } }), {
        code: 'INVALID_PROTOCOL',
      })
    }
  })
}

test('unknown emotion/action are valid strings; executable-looking strings remain inert data', () => {
  const value = validateChatResponse({
    ...response,
    reply: { ...response.reply, emotion: 'unknown', action: 'constructor' },
  })
  assert.equal(value.reply.emotion, 'unknown')
  assert.equal(value.reply.action, 'constructor')
})
