// Only numeric usage survives; no transcripts, prompts, credentials or raw errors.
export function numericUsage(value, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 4) return null
  const result = {}
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    if (!/^[a-z_]{1,64}$/.test(key)) continue
    if (typeof item === 'number' && Number.isFinite(item) && item >= 0) result[key] = item
    else if (item && typeof item === 'object') {
      const nested = numericUsage(item, depth + 1)
      if (nested && Object.keys(nested).length) result[key] = nested
    }
  }
  return result
}

export function newMetrics() {
  return {
    connection_time: null,
    session_ready_time: null,
    first_input_time: null,
    first_text_delta_time: null,
    first_audio_delta_time: null,
    response_start: null,
    TTFA: null,
    total_response_time: null,
    input_audio_bytes: 0,
    output_audio_bytes: 0,
    interruption_latency: null,
    reconnect_latency: null,
    usage: null,
  }
}
