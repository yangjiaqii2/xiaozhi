import { createHash, timingSafeEqual } from 'node:crypto'

const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
const digest = (token) => createHash('sha256').update(token).digest()
const validToken = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(value)

export class DeviceAuth {
  constructor(records, { now = () => Date.now() } = {}) {
    this.now = now
    this.replace(records)
  }
  // Build the complete replacement before publishing it. Raw tokens are never retained.
  replace(records) {
    if (!Array.isArray(records) || records.length < 1 || records.length > 1000) throw new Error('INVALID_DEVICE_CONFIG')
    const replacement = new Map()
    for (const record of records) {
      if (!id(record.deviceId) || replacement.has(record.deviceId)) throw new Error('INVALID_DEVICE_CONFIG')
      const tokens = record.tokens ?? []
      const hashes = record.tokenHashes ?? []
      const credentials = record.credentials ?? []
      if (
        !Array.isArray(tokens) ||
        !Array.isArray(hashes) ||
        !Array.isArray(credentials) ||
        tokens.length + hashes.length + credentials.length < 1 ||
        tokens.length + hashes.length + credentials.length > 4 ||
        tokens.some((v) => !validToken(v)) ||
        hashes.some((v) => typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v))
      )
        throw new Error('INVALID_DEVICE_CONFIG')
      if (record.requireNonce === true && (tokens.length || hashes.length)) throw new Error('INVALID_DEVICE_CONFIG')
      const keys = [
        ...tokens.map((token) => ({ hash: digest(token), notBefore: 0, expiresAt: null })),
        ...hashes.map((hash) => ({ hash: Buffer.from(hash, 'hex'), notBefore: 0, expiresAt: null })),
      ]
      for (const value of credentials) {
        if (
          !value ||
          (value.token !== undefined) === (value.tokenHash !== undefined) ||
          (value.token !== undefined
            ? !validToken(value.token)
            : typeof value.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.tokenHash)) ||
          !Number.isSafeInteger(value.expiresAt) ||
          value.expiresAt <= 0 ||
          !Number.isSafeInteger(value.notBefore ?? 0) ||
          (value.notBefore ?? 0) < 0 ||
          (value.notBefore ?? 0) >= value.expiresAt
        )
          throw new Error('INVALID_DEVICE_CONFIG')
        keys.push({
          hash: value.token === undefined ? Buffer.from(value.tokenHash, 'hex') : digest(value.token),
          notBefore: value.notBefore ?? 0,
          expiresAt: value.expiresAt,
        })
      }
      for (const name of ['personaId', 'voiceId', 'userId'])
        if (record[name] !== undefined && !id(record[name])) throw new Error('INVALID_DEVICE_CONFIG')
      if (record.requireNonce !== undefined && typeof record.requireNonce !== 'boolean')
        throw new Error('INVALID_DEVICE_CONFIG')
      if (
        record.instructions !== undefined &&
        (typeof record.instructions !== 'string' || record.instructions.length > 8192)
      )
        throw new Error('INVALID_DEVICE_CONFIG')
      replacement.set(record.deviceId, {
        keys,
        requireNonce: record.requireNonce === true,
        nonces: new Map(),
        identity: {
          deviceId: record.deviceId,
          personaId: record.personaId,
          voiceId: record.voiceId,
          userId: record.userId,
          instructions: record.instructions ?? '',
        },
      })
    }
    // Preserve consumed nonces across rotation, so retained credentials cannot replay.
    for (const [deviceId, record] of replacement) record.nonces = this.records?.get(deviceId)?.nonces ?? record.nonces
    this.records = replacement
  }
  authenticate(headers) {
    const deviceId = headers['x-device-id']
    const authorization = headers.authorization
    if (!id(deviceId) || typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{32,256}$/.test(authorization))
      return null
    const record = this.records.get(deviceId)
    const token = digest(authorization.slice(7))
    const now = this.now()
    let match = null
    for (const key of record?.keys ?? [{ hash: Buffer.alloc(32) }]) {
      if (timingSafeEqual(token, key.hash) && now >= key.notBefore && (key.expiresAt === null || now < key.expiresAt))
        match = key
    }
    return record && match
      ? { ...record.identity, credentialId: match.hash.toString('hex'), credentialExpiresAt: match.expiresAt }
      : null
  }
  isCurrent(identity) {
    const record = this.records.get(identity.deviceId)
    const now = this.now()
    return !!record?.keys.some(
      (key) =>
        key.hash.toString('hex') === identity.credentialId &&
        now >= key.notBefore &&
        (key.expiresAt === null || now < key.expiresAt),
    )
  }
  acceptConnection(identity, headers) {
    if (!this.isCurrent(identity)) return false
    const record = this.records.get(identity.deviceId)
    if (!record.requireNonce) return true // Legacy records remain explicit compatibility mode.
    const nonce = headers['x-device-nonce']
    const issued = headers['x-device-issued-at']
    const now = this.now()
    if (
      typeof nonce !== 'string' ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(nonce) ||
      typeof issued !== 'string' ||
      !/^\d{1,16}$/.test(issued) ||
      !Number.isSafeInteger(Number(issued)) ||
      Math.abs(now - Number(issued)) > 30000
    )
      return false
    for (const [value, expires] of record.nonces) if (expires <= now) record.nonces.delete(value)
    if (record.nonces.has(nonce) || record.nonces.size >= 128) return false
    record.nonces.set(nonce, now + 60001)
    return true
  }
}
