import { NetworkError } from 'my-companion/network-errors'
import { validateChatRequest, validateChatResponse } from 'my-companion/protocol'
import { State } from 'my-companion/state'

// Hardware-free conversation orchestration. Presentation and scheduling are ports,
// not guessed robot or SDK methods. No history, model client, recording or audio.
export class Conversation {
  constructor({ api, state, presentation, options, timer, now, logger }) {
    this.api = api
    this.state = state
    this.presentation = presentation
    this.options = options
    this.timer = timer
    this.now = now
    this.logger = logger
    this.sequence = 0
    this.closed = false
    this.active = false
    this.cancelWait = null
  }

  async chat(text) {
    if (this.closed) return { ok: false, code: 'CLOSED' }
    if (this.active) return { ok: false, code: 'BUSY' }
    this.active = true
    try {
      this.sequence = (this.sequence + 1) >>> 0
      const body = validateChatRequest({
        deviceId: this.options.deviceId,
        requestId: `chat-${this.now() >>> 0}-${this.sequence}`,
        text,
      })
      this.state.transition(State.THINKING)
      const retry = this.options.retry
      // POST retries are opt-in only for a server with a requestId idempotence contract.
      const attempts = retry.enabled === true && this.options.idempotentServer === true ? retry.maxAttempts : 1
      if (
        !Number.isInteger(attempts) ||
        attempts < 1 ||
        attempts > 3 ||
        !Number.isInteger(retry.delayMs) ||
        retry.delayMs < 1 ||
        retry.delayMs > 60000
      ) {
        throw new NetworkError('INVALID_CONFIG')
      }
      let response
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (this.closed) throw new NetworkError('CANCELLED')
        this.logger.debug(`POST ${this.options.path} requestId=${body.requestId} attempt=${attempt}`)
        try {
          response = await this.api.post(this.options.path, body)
          break
        } catch (error) {
          const retryable =
            ['NETWORK_ERROR', 'TIMEOUT'].includes(error.code) || [500, 502, 503, 504].includes(error.status)
          if (this.closed || !retryable || attempt === attempts) throw error
          this.logger.debug(`retry requestId=${body.requestId} code=${error.code}`)
          await this.wait(retry.delayMs)
        }
      }
      if (this.closed) throw new NetworkError('CANCELLED')
      const { reply } = validateChatResponse(response.data, body.requestId)
      // Entering the host's speaking state first establishes its default face/pose.
      // Apply the validated response afterwards so those defaults cannot overwrite it.
      this.state.transition(State.SPEAKING)
      await this.presentation.reply(reply)
      return { ok: true, requestId: body.requestId }
    } catch (error) {
      const code = error instanceof NetworkError ? error.code : 'CONVERSATION_ERROR'
      this.logger.error(code)
      return { ok: false, code }
    } finally {
      this.active = false
      if (!this.closed) this.state.transition(State.IDLE)
    }
  }

  wait(ms) {
    return new Promise((resolve, reject) => {
      const id = this.timer.set(() => {
        this.cancelWait = null
        resolve()
      }, ms)
      this.cancelWait = () => {
        this.timer.clear(id)
        this.cancelWait = null
        reject(new NetworkError('CANCELLED'))
      }
    })
  }

  close() {
    this.closed = true
    this.cancelWait?.()
    this.presentation.close()
  }
}
