// Linux acceptance instrumentation only. Does not change the device protocol.
export function batchProviderInput(provider, chunkMs = 20) {
  if (![20, 40, 60].includes(chunkMs)) throw new Error('INVALID_ACCEPTANCE_CHUNK')
  const send = provider.send.bind(provider)
  const pieces = []
  let bytes = 0
  const metrics = { messages: 0, maxPendingBytes: 0 }
  const flush = () => {
    if (!pieces.length) return
    const audio = Buffer.concat(pieces, bytes).toString('base64')
    pieces.length = 0
    bytes = 0
    send({ type: 'input_audio_buffer.append', audio })
    metrics.messages++
  }
  provider.send = (event) => {
    if (event.type !== 'input_audio_buffer.append') {
      flush()
      return send(event)
    }
    const pcm = Buffer.from(event.audio, 'base64')
    if (!pcm.length || pcm.length > 1920 || pcm.length % 2) throw new Error('INVALID_ACCEPTANCE_PCM')
    pieces.push(pcm)
    bytes += pcm.length
    metrics.maxPendingBytes = Math.max(metrics.maxPendingBytes, bytes)
    if (pieces.length >= chunkMs / 20) flush()
  }
  return { flush, metrics }
}

export function assertStreamCompleted(records) {
  if (!records.some((record) => record.type === 'stream_completed')) throw new Error('STREAM_INCOMPLETE')
}
