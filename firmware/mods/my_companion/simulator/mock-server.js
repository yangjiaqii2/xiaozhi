import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { parseJSON, validateChatRequest } from '../ai/protocol.js'
import { environmentOptions, scenarios } from './config.js'

export class MockServer {
  constructor({ port = 8787, latencyMs = 500, scenario = '200' } = {}) {
    if (
      !Number.isInteger(port) ||
      port < 0 ||
      port > 65535 ||
      !Number.isInteger(latencyMs) ||
      latencyMs < 0 ||
      latencyMs > 60000
    ) {
      throw new Error('INVALID_MOCK_SERVER_CONFIG')
    }
    this.port = port
    this.latencyMs = latencyMs
    this.setScenario(scenario)
    this.pendingTimers = new Set()
    this.cache = new Map()
    this.stats = { requests: 0, chatRequests: 0, repliesComputed: 0 }
    this.server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 5000 }, (request, response) =>
      this.handle(request, response),
    )
    this.server.on('clientError', (_error, socket) => socket.destroy())
    this.closing = null
  }

  setScenario(scenario) {
    if (!scenarios.includes(scenario)) throw new Error('INVALID_SCENARIO')
    this.scenario = scenario
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, '127.0.0.1', () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    this.port = this.server.address().port
    this.baseUrl = `http://127.0.0.1:${this.port}`
    return this
  }

  handle(request, response) {
    this.stats.requests += 1
    let path
    try {
      path = new URL(request.url, 'http://127.0.0.1').pathname
    } catch {
      this.send(response, 400, { error: { code: 'INVALID_PATH' } })
      return
    }
    if (request.method === 'POST' && path === '/api/chat') this.stats.chatRequests += 1
    const buffer = Buffer.alloc(8192)
    let length = 0
    let rejected = false
    request.on('data', (chunk) => {
      if (rejected) return
      if (chunk.length > buffer.length - length) {
        rejected = true
        this.send(response, 413, { error: { code: 'REQUEST_TOO_LARGE' } })
        return
      }
      chunk.copy(buffer, length)
      length += chunk.length
    })
    request.on('error', () => response.destroy())
    request.on('end', () => {
      if (rejected || response.destroyed) return
      let result
      try {
        result = this.route(request.method, path, buffer.subarray(0, length))
      } catch {
        this.send(response, 400, { error: { code: 'INVALID_PROTOCOL' } })
        return
      }
      if (!result) {
        this.send(response, 404, { error: { code: 'NOT_FOUND' } })
        return
      }
      const scenario = this.scenario
      if (scenario === 'timeout') return // Deliberately no response; client deadline must close it.
      const id = setTimeout(() => {
        this.pendingTimers.delete(id)
        if (response.destroyed) return
        if (/^[45]\d\d$/.test(scenario)) {
          this.send(response, Number(scenario), { error: { code: `MOCK_${scenario}` } })
        } else if (scenario === 'invalid-json') this.send(response, 200, '{broken', true)
        else if (scenario === 'large-response') this.send(response, 200, { padding: 'x'.repeat(40000) })
        else {
          if (result.reply) {
            // Copy before injecting faults; cached successful replies remain immutable.
            result = { ...result, reply: { ...result.reply } }
            if (scenario === 'unknown-emotion') result.reply.emotion = 'unknown'
            if (scenario === 'unknown-action') result.reply.action = 'constructor'
            if (scenario === 'invalid-protocol') result.reply.text = 123
            if (scenario === 'wrong-request-id') result.requestId = 'unrelated'
          }
          this.send(response, 200, result)
        }
      }, this.latencyMs)
      this.pendingTimers.add(id)
      response.once('close', () => {
        clearTimeout(id)
        this.pendingTimers.delete(id)
      })
    })
  }

  route(method, path, body) {
    if (method === 'GET' && path === '/api/health') return { status: 'ok', serverTime: new Date().toISOString() }
    if (method === 'GET' && path === '/api/device/config') {
      return { deviceId: 'robot-001', persona: { name: '小七' }, features: { voiceChat: true, vision: true } }
    }
    if (method !== 'POST' || path !== '/api/chat') return null
    const input = validateChatRequest(parseJSON(body.toString('utf8')))
    const now = Date.now()
    for (const [key, entry] of this.cache) if (now - entry.createdAt > 60000) this.cache.delete(key)
    const key = JSON.stringify([input.deviceId, input.requestId])
    const cached = this.cache.get(key)
    if (cached) {
      if (cached.text !== input.text) throw new Error('IDEMPOTENCY_CONFLICT')
      return cached.response
    }
    const result = {
      requestId: input.requestId,
      reply: {
        text: '你好呀，我是小七。',
        emotion: 'happy',
        action: 'look_around',
        voiceId: 'default',
      },
    }
    while (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value)
    this.cache.set(key, { createdAt: now, text: input.text, response: result })
    this.stats.repliesComputed += 1
    return result
  }

  send(response, status, data, raw = false) {
    if (response.destroyed || response.writableEnded) return
    const body = raw ? data : JSON.stringify(data)
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      Connection: 'close',
    })
    response.end(body)
  }

  close() {
    if (this.closing) return this.closing
    for (const id of this.pendingTimers) clearTimeout(id)
    this.pendingTimers.clear()
    this.cache.clear()
    this.closing = new Promise((resolve) => {
      this.server.close(() => resolve())
      this.server.closeAllConnections()
    })
    return this.closing
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = new MockServer(environmentOptions())
  try {
    await server.start()
    console.log(`[MockServer] ${server.baseUrl} scenario=${server.scenario}`)
    const stop = () => {
      void server.close()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  } catch (error) {
    console.error(`[MockServer] ${error.code ?? 'START_FAILED'}`)
    process.exitCode = 1
  }
}
