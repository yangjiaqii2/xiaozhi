// Time readability, unauthenticated synchronization and authenticated trust differ.
export class TrustedTime {
  constructor({ runtime, wifi, timeoutMs = 10000, verifyEvidence } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('INVALID_TIME_CONFIG')
    Object.assign(this, { runtime, wifi, timeoutMs, verifyEvidence })
    this.synchronized = false
    this.trust = null
    this.pending = null
    this.cancel = null
    this.lastError = null
    this.disposed = false
  }
  sync() {
    if (this.pending) return this.pending
    if (this.disposed) return Promise.resolve({ ok: false, code: 'DISPOSED' })
    if (!this.wifi?.isConnected()) return Promise.resolve({ ok: false, code: 'NETWORK_DISCONNECTED' })
    let finish,
      handle,
      resource,
      settled = false
    const task = new Promise((resolve) => {
      finish = (code) => {
        if (settled) return
        settled = true
        if (handle !== undefined) this.runtime.timer.clear(handle)
        try {
          resource?.close()
        } catch {}
        this.lastError = code
        this.cancel = null
        this.pending = null
        resolve({ ok: false, code })
      }
    })
    this.pending = task
    this.cancel = () => finish('CANCELLED')
    handle = this.runtime.timer.set(() => finish('TIME_SYNC_TIMEOUT'), this.timeoutMs)
    try {
      resource = this.runtime.sync((error, seconds) => {
        if (settled) return
        if (error || !Number.isSafeInteger(seconds) || seconds < 1704067200 || seconds > 4102444800)
          return finish('TIME_SYNC_ERROR')
        try {
          this.runtime.setTime(seconds)
        } catch {
          return finish('TIME_SYNC_ERROR')
        }
        this.trust = null
        this.synchronized = true
        finish('TIME_UNVERIFIED') // SNTP has no authenticated source proof.
      })
      if (settled) {
        try {
          resource?.close()
        } catch {}
      }
    } catch {
      finish('TIME_SYNC_ERROR')
    }
    return task
  }
  acceptEvidence(proof) {
    // Only a locally installed verifier may authenticate evidence. The MOD has none.
    if (
      this.disposed ||
      !this.verifyEvidence ||
      !Number.isSafeInteger(proof?.unixMs) ||
      proof.unixMs < 1704067200000 ||
      !Number.isInteger(proof.validForMs) ||
      proof.validForMs < 1 ||
      proof.validForMs > 3600000
    )
      return false
    try {
      if (this.verifyEvidence(proof) !== true) return false
      this.stop()
      this.runtime.setTime(proof.unixMs / 1000)
      this.trust = { at: this.runtime.now(), unixMs: proof.unixMs, lifetime: proof.validForMs }
      this.lastError = null
      return true
    } catch {
      this.trust = null
      return false
    }
  }
  isTrusted() {
    if (this.disposed || !this.trust) return false
    const age = this.runtime.elapsed(this.trust.at, this.runtime.now())
    return (
      age >= 0 && age < this.trust.lifetime && Math.abs(this.runtime.unixTime() - (this.trust.unixMs + age)) <= 2000
    )
  }
  getDiagnostics() {
    return {
      readable: Number.isFinite(this.runtime.unixTime()),
      synchronized: this.synchronized,
      trusted: this.isTrusted(),
      pending: !!this.pending,
      lastError: this.lastError,
      verifierInstalled: !!this.verifyEvidence,
    }
  }
  stop() {
    this.cancel?.()
  }
  dispose() {
    this.stop()
    this.trust = null
    this.disposed = true
  }
}
