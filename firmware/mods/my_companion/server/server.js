import http from 'node:http'
import https from 'node:https'
import { WebSocketServer } from 'ws'
import { DeviceAuth } from './auth.js'
import { DeviceSession } from './device-session.js'
import { ServerTools } from './tools.js'

export class AIServer {
  constructor({
    devices,
    providerFactory,
    port = 8787,
    host = '127.0.0.1',
    tls,
    maxSessions = 8,
    maxRetries = 2,
    retryDelayMs = 250,
    maxSessionMs,
    tools = new ServerTools(),
    log = () => {},
  }) {
    if (
      (!tls && host !== '127.0.0.1') ||
      !Number.isInteger(port) ||
      port < 0 ||
      port > 65535 ||
      !Number.isInteger(maxRetries) ||
      maxRetries < 0 ||
      maxRetries > 2 ||
      !Number.isInteger(maxSessions) ||
      maxSessions < 1 ||
      maxSessions > 64
    )
      throw new Error('INVALID_SERVER_CONFIG')
    this.auth = new DeviceAuth(devices)
    this.options = { providerFactory, log, maxRetries, retryDelayMs, maxSessionMs, tools }
    this.port = port
    this.host = host
    this.secure = Boolean(tls)
    this.sessions = new Map()
    this.rates = new Map()
    this.maxSessions = maxSessions
    const handler = (request, response) => {
      if (request.method === 'GET' && request.url === '/api/health') return this.json(response, 200, { status: 'ok' })
      const device = this.auth.authenticate(request.headers)
      if (!device) return this.json(response, 401, { error: { code: 'DEVICE_UNAUTHORIZED' } })
      if (request.method === 'GET' && request.url === '/api/device/config')
        return this.json(response, 200, {
          deviceId: device.deviceId,
          persona: {},
          features: { voiceChat: true, vision: false },
        })
      this.json(response, 404, { error: { code: 'NOT_FOUND' } })
    }
    const config = { maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 5000 }
    this.server = tls
      ? https.createServer({ ...config, ...tls, minVersion: 'TLSv1.2' }, handler)
      : http.createServer(config, handler)
    this.server.maxConnections = 64
    this.server.on('clientError', (_error, socket) => socket.destroy())
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: 4096,
      perMessageDeflate: false,
      maxFragments: 16,
      closeTimeout: 1000,
    })
    this.server.on('upgrade', (request, socket, head) => {
      socket.on('error', () => {})
      const device = this.auth.authenticate(request.headers)
      if (!device) return this.reject(socket, 401, 'DEVICE_UNAUTHORIZED')
      if (request.url !== '/api/realtime') return this.reject(socket, 404, 'NOT_FOUND')
      if (this.sessions.has(device.deviceId)) return this.reject(socket, 409, 'DEVICE_BUSY')
      const now = performance.now()
      let rate = this.rates.get(device.deviceId)
      if (!rate || now - rate.start > 60000) {
        rate = { start: now, count: 0 }
        this.rates.set(device.deviceId, rate)
      }
      if (++rate.count > 6 || this.sessions.size >= this.maxSessions) return this.reject(socket, 429, 'RATE_LIMIT')
      if (!this.auth.acceptConnection(device, request.headers)) return this.reject(socket, 401, 'DEVICE_UNAUTHORIZED')
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        const session = new DeviceSession(ws, device, {
          ...this.options,
          onClose: () => {
            clearTimeout(session.credentialTimer)
            this.sessions.delete(device.deviceId)
          },
        })
        this.sessions.set(device.deviceId, session)
        this.scheduleCredentialExpiry(session)
      })
    })
  }

  scheduleCredentialExpiry(session) {
    clearTimeout(session.credentialTimer)
    const expiry = session.identity.credentialExpiresAt
    if (expiry === null) return
    const remaining = expiry - Date.now()
    if (remaining <= 0 || !this.auth.isCurrent(session.identity)) {
      session.close()
      return
    }
    session.credentialTimer = setTimeout(() => this.scheduleCredentialExpiry(session), Math.min(remaining, 2147483647))
  }
  updateDevices(records) {
    this.auth.replace(records)
    for (const id of this.rates.keys()) if (!this.auth.records.has(id)) this.rates.delete(id)
    // Revoke active sessions as well as future handshakes. No provider retry on revocation.
    for (const session of [...this.sessions.values()]) {
      if (!this.auth.isCurrent(session.identity)) session.close()
      else {
        const key = this.auth.records
          .get(session.identity.deviceId)
          .keys.find((value) => value.hash.toString('hex') === session.identity.credentialId)
        session.identity.credentialExpiresAt = key.expiresAt
        this.scheduleCredentialExpiry(session)
      }
    }
  }

  json(response, status, body) {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify(body))
  }
  reject(socket, status, code) {
    this.options.log({ type: 'handshake_rejected', code, httpStatus: status })
    const body = JSON.stringify({ error: { code } })
    socket.end(
      `HTTP/1.1 ${status} ${code}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    )
  }
  async start() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    this.port = this.server.address().port
    this.url = `${this.secure ? 'wss' : 'ws'}://${this.host}:${this.port}/api/realtime`
    return this
  }
  close() {
    if (this.closing) return this.closing
    for (const session of [...this.sessions.values()]) session.close()
    this.wss.close()
    this.server.closeAllConnections()
    this.rates.clear()
    this.closing = new Promise((resolve) => this.server.close(resolve))
    return this.closing
  }
}
