import { NetworkError } from 'my-companion/network-errors'

export function parseJSON(text) {
  try {
    return JSON.parse(text)
  } catch {
    throw new NetworkError('INVALID_JSON')
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireValue(condition) {
  if (!condition) throw new NetworkError('INVALID_PROTOCOL')
}

export function validateDeviceConfig(value) {
  requireValue(object(value))
  requireValue(typeof value.deviceId === 'string' && value.deviceId.trim().length > 0 && value.deviceId.length <= 64)
  const result = { deviceId: value.deviceId }
  if (value.persona !== undefined) {
    requireValue(object(value.persona))
    result.persona = {}
    if (value.persona.name !== undefined) {
      requireValue(typeof value.persona.name === 'string' && value.persona.name.length <= 64)
      result.persona.name = value.persona.name
    }
  }
  if (value.features !== undefined) {
    requireValue(object(value.features))
    result.features = {}
    for (const key of ['voiceChat', 'vision', 'emotionAnalysis']) {
      if (value.features[key] !== undefined) {
        requireValue(typeof value.features[key] === 'boolean')
        result.features[key] = value.features[key]
      }
    }
  }
  return result
}

export function validateHealthResponse(value) {
  requireValue(object(value) && ['ok', 'degraded', 'error'].includes(value.status))
  const result = { status: value.status }
  if (value.serverTime !== undefined) {
    requireValue(typeof value.serverTime === 'string' && value.serverTime.length <= 64)
    result.serverTime = value.serverTime
  }
  return result
}

function boundedString(value, maximum) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= maximum)
  return value
}

export function validateChatRequest(value) {
  requireValue(object(value))
  return {
    deviceId: boundedString(value.deviceId, 64),
    requestId: boundedString(value.requestId, 64),
    text: boundedString(value.text, 1024),
  }
}

export function validateChatResponse(value, expectedRequestId) {
  requireValue(object(value))
  const requestId = boundedString(value.requestId, 64)
  requireValue(expectedRequestId === undefined || requestId === expectedRequestId)
  requireValue(object(value.reply))
  // Protocol validates shape and size, not the set of supported emotions/actions.
  return {
    requestId,
    reply: {
      text: boundedString(value.reply.text, 2048),
      emotion: boundedString(value.reply.emotion, 32),
      action: boundedString(value.reply.action, 64),
      voiceId: boundedString(value.reply.voiceId, 64),
    },
  }
}
