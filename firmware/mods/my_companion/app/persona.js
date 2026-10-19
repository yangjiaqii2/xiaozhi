function text(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit) : ''
}

// Retain bounded, known fields; no hardcoded prompt or conversation history.
export function loadPersona(input) {
  const source = input && typeof input === 'object' ? input : {}
  const personality = Array.isArray(source.personality)
    ? source.personality.slice(0, 6).map((item) => text(item, 64))
    : typeof source.personality === 'string'
      ? [text(source.personality, 192)]
      : []
  return {
    name: text(source.name, 64),
    personality,
    speakingStyle: text(source.speakingStyle, 160),
    voiceId: text(source.voiceId, 64),
    initiativeLevel: Number.isFinite(source.initiativeLevel)
      ? Math.max(0, Math.min(3, Math.floor(source.initiativeLevel)))
      : 0,
  }
}
