// Protocol v1: control JSON; 16-byte big-endian header followed by PCM s16le.
export const audioFormat = Object.freeze({
  input: Object.freeze({ encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 }),
  output: Object.freeze({ encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 }),
})

export function fail(code) {
  const error = new Error(code)
  error.code = code
  throw error
}

export function identifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
}

export function uint(value) {
  return Number.isInteger(value) && value > 0 && value <= 0xffffffff
}

export function validateStart(value) {
  if (value?.type !== 'session.start' || value.version !== 1) fail('INVALID_SESSION_START')
  for (const key of ['deviceId', 'requestId']) if (!identifier(value[key])) fail('INVALID_SESSION_START')
  for (const key of ['personaId', 'voiceId', 'userId']) {
    if (value[key] !== undefined && !identifier(value[key])) fail('INVALID_SESSION_START')
  }
  return value
}

export function parseEvent(text, maxBytes) {
  // Checking JS length first avoids parsing enormous strings. Byte limit is also
  // enforced by the transport before decoding; protocol fields below are bounded.
  if (typeof text !== 'string' || text.length > maxBytes) fail('MESSAGE_TOO_LARGE')
  let event
  try {
    event = JSON.parse(text)
  } catch {
    fail('INVALID_MESSAGE')
  }
  if (!event || Array.isArray(event) || !identifier(event.sessionId)) fail('INVALID_MESSAGE')
  if (event.type === 'session.ready') {
    if (!identifier(event.requestId)) fail('INVALID_MESSAGE')
    for (const side of ['input', 'output']) {
      for (const key of ['encoding', 'sampleRate', 'channels']) {
        if (event.audio?.[side]?.[key] !== audioFormat[side][key]) fail('UNSUPPORTED_AUDIO_FORMAT')
      }
    }
  } else if (event.type === 'error') {
    if (typeof event.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(event.code)) fail('INVALID_MESSAGE')
  } else if (event.type === 'session.pong') {
    if (!uint(event.sequence)) fail('INVALID_MESSAGE')
  } else {
    if (!uint(event.turnId)) fail('INVALID_MESSAGE')
    switch (event.type) {
      case 'response.text.delta':
        if (typeof event.delta !== 'string' || event.delta.length > 512) fail('INVALID_MESSAGE')
        break
      case 'response.begin':
      case 'response.done':
      case 'input.speech.started':
      case 'input.speech.stopped':
        break
      case 'assistant.emotion':
      case 'assistant.action': {
        const value = event[event.type === 'assistant.emotion' ? 'emotion' : 'action']
        if (typeof value !== 'string' || !/^[a-z_]{1,32}$/.test(value)) fail('INVALID_MESSAGE')
        break
      }
      default:
        fail('INVALID_MESSAGE')
    }
  }
  return event
}

export function encodeAudio(direction, turnId, sequence, pcm, maxBytes) {
  if (!(pcm instanceof ArrayBuffer) || !pcm.byteLength || pcm.byteLength % 2 || pcm.byteLength > maxBytes)
    fail('INVALID_AUDIO_CHUNK')
  if (![1, 2].includes(direction) || !uint(turnId) || !uint(sequence)) fail('INVALID_AUDIO_HEADER')
  const result = new ArrayBuffer(16 + pcm.byteLength)
  const view = new DataView(result)
  view.setUint16(0, 0x5343)
  view.setUint8(2, 1)
  view.setUint8(3, direction)
  view.setUint32(4, turnId)
  view.setUint32(8, sequence)
  view.setUint32(12, pcm.byteLength)
  new Uint8Array(result, 16).set(new Uint8Array(pcm))
  return result
}

export function decodeAudio(frame, direction, maxBytes) {
  if (!(frame instanceof ArrayBuffer) || frame.byteLength < 18 || frame.byteLength > maxBytes + 16)
    fail('INVALID_AUDIO_CHUNK')
  const view = new DataView(frame)
  const turnId = view.getUint32(4)
  const sequence = view.getUint32(8)
  if (
    view.getUint16(0) !== 0x5343 ||
    view.getUint8(2) !== 1 ||
    view.getUint8(3) !== direction ||
    !uint(turnId) ||
    !uint(sequence) ||
    view.getUint32(12) !== frame.byteLength - 16 ||
    frame.byteLength % 2
  )
    fail('INVALID_AUDIO_HEADER')
  return { turnId, sequence, pcm: frame.slice(16) }
}
