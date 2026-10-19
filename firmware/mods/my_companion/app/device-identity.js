import { fail, identifier } from 'my-companion/realtime-protocol'

// RAM only. No NVS security claim, automatic enrollment or upstream API keys.
export class DeviceIdentity {
  #credential = null
  #listeners = new Set()
  constructor({ unixTime = () => Date.now(), isTimeTrusted = () => false, nonce } = {}) {
    this.unixTime = unixTime
    this.isTimeTrusted = isTimeTrusted
    this.nonce = nonce
    this.blocked = false
    this.disposed = false
    this.revision = 0
  }
  provision(value, { confirmed = false } = {}) {
    if (this.disposed) fail('DISPOSED')
    if (!confirmed) fail('EXPLICIT_PROVISION_REQUIRED')
    if (
      !identifier(value?.deviceId) ||
      typeof value.token !== 'string' ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(value.token) ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= 0 ||
      !Number.isSafeInteger(value.notBefore ?? 0) ||
      (value.notBefore ?? 0) < 0 ||
      (value.notBefore ?? 0) >= value.expiresAt
    )
      fail('INVALID_CREDENTIALS')
    this.#credential = {
      deviceId: value.deviceId,
      token: value.token,
      expiresAt: value.expiresAt,
      notBefore: value.notBefore ?? 0,
    }
    this.blocked = false
    this.revision++
    this.changed()
  }
  assertUsable() {
    if (this.disposed) fail('DISPOSED')
    if (!this.#credential || this.blocked) fail('DEVICE_UNAUTHORIZED')
    if (!this.isTimeTrusted()) fail('TIME_UNVERIFIED')
    const issuedAt = this.unixTime()
    if (
      !Number.isSafeInteger(issuedAt) ||
      issuedAt >= this.#credential.expiresAt ||
      issuedAt < this.#credential.notBefore
    )
      fail('CREDENTIAL_EXPIRED')
    return issuedAt
  }
  connectionCredentials() {
    const issuedAt = this.assertUsable()
    let nonce
    try {
      nonce = this.nonce?.()
    } catch {
      fail('NONCE_UNAVAILABLE')
    }
    if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(nonce)) fail('NONCE_UNAVAILABLE')
    return { ...this.#credential, nonce, issuedAt }
  }
  reject() {
    this.blocked = true
    this.changed()
  }
  onChange(listener) {
    if (this.disposed) return () => {}
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
  changed() {
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch {}
    }
  }
  getDiagnostics() {
    return {
      configured: !!this.#credential,
      blocked: this.blocked,
      disposed: this.disposed,
      revision: this.revision,
      storage: 'VOLATILE_RAM',
      encryptedPersistence: 'UNVERIFIED',
    }
  }
  dispose() {
    if (this.disposed) return
    this.#credential = null // JS immutable strings cannot be guaranteed securely erased.
    this.disposed = true
    this.changed()
    this.#listeners.clear()
  }
}
