export const gaProtocol = Object.freeze({
  textDelta: 'response.output_text.delta',
  audioDelta: 'response.output_audio.delta',
  transcriptDelta: 'response.output_audio_transcript.delta',
  configure(config) {
    return {
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: config.mode === 'text' ? ['text'] : ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: config.inputRate },
            transcription: { model: 'whisper-1' },
            turn_detection:
              config.vad === 'manual'
                ? null
                : {
                    type: config.vad,
                    ...(config.vadSilenceMs === undefined ? {} : { silence_duration_ms: config.vadSilenceMs }),
                  },
          },
          output: { format: { type: 'audio/pcm', rate: config.outputRate }, voice: config.voice, speed: 1.0 },
        },
        ...(config.instructions ? { instructions: config.instructions } : {}),
      },
    }
  },
})
