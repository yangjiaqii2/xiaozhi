import { fail } from 'my-companion/realtime-protocol'

// Transport has no retry policy or audio knowledge. Session owns those lifetimes.
export class RealtimeClient {
  constructor(runtime, options, events) {
    this.runtime = runtime
    this.options = options
    this.events = events
    this.transport = null
    this.epoch = 0
  }

  start() {
    if (this.transport) return
    const epoch = ++this.epoch
    const events = {}
    for (const key of ['open', 'message', 'error', 'close']) {
      events[key] = (...args) => {
        if (epoch === this.epoch) this.events[key](...args)
      }
    }
    this.transport = this.runtime.connect(this.options.url, events, this.options)
  }

  send(value) {
    if (!this.transport) fail('NOT_CONNECTED')
    const data = typeof value === 'object' && !(value instanceof ArrayBuffer) ? JSON.stringify(value) : value
    this.transport.send(data)
  }

  stop() {
    ++this.epoch
    const transport = this.transport
    this.transport = null
    transport?.close()
  }

  dispose() {
    this.stop()
    this.events = null
  }
}
