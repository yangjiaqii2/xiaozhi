import { AudioInput } from 'my-companion/audio-input'
import { AudioOutput } from 'my-companion/audio-output'
import { fail } from 'my-companion/realtime-protocol'
import AudioOut from 'pins/audioout'

// Caller must hold exclusive audio ownership; no TTS/radio may run concurrently.
// Available APIs are source-confirmed; actual duplex/AEC remains device-unverified.
export function createAudioRuntime(robot, options = {}) {
  // Both directions share I2S1/BCK/LR but currently request different clocks.
  // This flag is a validation precondition, not an implementation of duplex.
  if (options.duplexValidated !== true) fail('AUDIO_DUPLEX_UNVERIFIED')
  return {
    input: new AudioInput(robot.audio.microphone, options.input),
    output: new AudioOutput(AudioOut, options.output),
  }
}
