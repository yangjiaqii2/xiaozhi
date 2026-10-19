import { EventEmitter } from 'node:events'

// Provider-neutral contract. Concrete adapters emit only these normalized names;
// peer payloads/errors are never logged or forwarded as arbitrary device events.
export const providerEvents = Object.freeze([
  'session_ready',
  'input_transcript_delta',
  'input_transcript_done',
  'text_delta',
  'audio_delta',
  'response_started',
  'response_done',
  'interrupted',
  'error',
  'disconnected',
  'speech_started',
  'speech_stopped',
  'function_call',
])

export class RealtimeProvider extends EventEmitter {
  constructor() {
    super()
    this.on('error', () => {})
  }
  connect() {
    throw new Error('PROVIDER_NOT_IMPLEMENTED')
  }
  configureSession() {
    throw new Error('PROVIDER_NOT_IMPLEMENTED')
  }
  sendAudioChunk() {
    throw new Error('PROVIDER_NOT_IMPLEMENTED')
  }
  sendText() {
    throw new Error('PROVIDER_NOT_IMPLEMENTED')
  }
  commitInput() {
    throw new Error('PROVIDER_NOT_IMPLEMENTED')
  }
  createResponse() {
    throw new Error('PROVIDER_NOT_IMPLEMENTED')
  }
  cancelResponse() {
    throw new Error('PROVIDER_NOT_IMPLEMENTED')
  }
  close() {
    throw new Error('PROVIDER_NOT_IMPLEMENTED')
  }
}
