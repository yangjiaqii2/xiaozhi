// No built-in GPT/search/database calls. Only explicitly registered server code
// is executable, with bounded arguments/result and an abortable deadline.
export class ServerTools {
  constructor(handlers = {}, timeoutMs = 5000) {
    this.handlers = handlers
    this.timeoutMs = timeoutMs
  }
  async execute(name, json, signal) {
    if (signal.aborted) throw new Error('TOOL_CANCELLED')
    if (!Object.hasOwn(this.handlers, name)) return JSON.stringify({ error: 'TOOL_UNAVAILABLE' })
    const args = JSON.parse(json)
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('INVALID_TOOL_ARGUMENTS')
    const controller = new AbortController()
    let timer
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    try {
      const result = await Promise.race([
        this.handlers[name](args, controller.signal),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new Error('TOOL_TIMEOUT'))
          }, this.timeoutMs)
          controller.signal.addEventListener('abort', () => reject(new Error('TOOL_CANCELLED')), { once: true })
          if (signal.aborted) controller.abort()
        }),
      ])
      const text = JSON.stringify(result)
      if (typeof text !== 'string' || text.length > 8192) throw new Error('TOOL_RESULT_TOO_LARGE')
      return text
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      controller.abort()
    }
  }
}
