export const omniProtocol = Object.freeze({
  textDelta: 'response.text.delta',
  audioDelta: 'response.audio.delta',
  transcriptDelta: 'response.audio_transcript.delta',
  configure(config) {
    return {
      type: 'session.update',
      session: {
        modalities: config.mode === 'text' ? ['text'] : ['text', 'audio'],
        voice: config.voice,
        input_audio_format: 'pcm',
        output_audio_format: 'pcm',
        input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
        turn_detection:
          config.vad === 'manual'
            ? null
            : {
                type: config.vad,
                ...(config.vadSilenceMs === undefined ? {} : { silence_duration_ms: config.vadSilenceMs }),
              },
        ...(config.instructions ? { instructions: config.instructions } : {}),
      },
    }
  },
})
