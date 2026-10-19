import assert from 'node:assert/strict'
import test from 'node:test'
import { Simulator } from '../simulator.js'

async function create(options = {}) {
  const lines = []
  const simulator = new Simulator({
    port: 0,
    latencyMs: 0,
    timeoutMs: 100,
    speakingMs: 1,
    retryDelayMs: 10,
    debug: false,
    write: (line) => lines.push(line),
    ...options,
  })
  await simulator.start()
  return { simulator, lines }
}

test('real local HTTP → shared Companion/ApiClient/Protocol → face/action/speaking → IDLE', async () => {
  const { simulator: sim, lines } = await create()
  try {
    assert.equal(sim.companion.networkStatus, 'CONNECTED')
    assert.equal((await sim.testServer()).ok, true)
    assert.equal((await sim.chat('你好')).ok, true)
    assert.equal(sim.companion.state.current, 'IDLE')
    assert(lines.some((line) => line.includes('THINKING')))
    assert(lines.some((line) => line.includes('[FACE] emotion=HAPPY')))
    assert(lines.some((line) => line.includes('[MOTION] look_around')))
    assert(lines.some((line) => line.includes('[SPEAKING]')))
    assert.equal(sim.server.stats.chatRequests, 1)
    assert.equal(sim.companion.config.features.vision, false)
  } finally {
    await sim.close()
  }
})

for (const [scenario, code, attempts] of [
  ['400', 'BAD_REQUEST', 1],
  ['401', 'AUTH_ERROR', 1],
  ['404', 'NOT_FOUND', 1],
  ['429', 'RATE_LIMIT', 1],
  ['500', 'SERVER_ERROR', 2],
  ['503', 'SERVER_ERROR', 2],
  ['timeout', 'TIMEOUT', 2],
  ['invalid-json', 'INVALID_JSON', 1],
  ['large-response', 'RESPONSE_TOO_LARGE', 1],
  ['invalid-protocol', 'INVALID_PROTOCOL', 1],
  ['wrong-request-id', 'INVALID_PROTOCOL', 1],
]) {
  test(`chat scenario ${scenario} → ${code}, attempts=${attempts}, then IDLE`, async () => {
    const { simulator: sim } = await create({ scenario })
    try {
      assert.deepEqual(await sim.chat('你好'), { ok: false, code })
      assert.equal(sim.companion.state.current, 'IDLE')
      assert.equal(sim.server.stats.chatRequests, attempts)
    } finally {
      await sim.close()
    }
  })
}

test('unknown emotion falls back, unknown action is ignored, and no arbitrary property executes', async () => {
  for (const scenario of ['unknown-emotion', 'unknown-action']) {
    const { simulator: sim, lines } = await create({ scenario })
    try {
      assert.equal((await sim.chat('你好')).ok, true)
      assert(lines.some((line) => line.includes(scenario === 'unknown-emotion' ? 'unknown emotion' : 'ignored action')))
      assert.equal(sim.companion.state.current, 'IDLE')
    } finally {
      await sim.close()
    }
  }
})

test('manual Wi-Fi toggle blocks requests without contacting server and reconnects', async () => {
  const { simulator: sim } = await create()
  try {
    await sim.toggleWiFi()
    assert.equal(sim.companion.wifi.getStatus(), 'DISCONNECTED')
    assert.deepEqual(await sim.chat('offline'), { ok: false, code: 'NETWORK_DISCONNECTED' })
    assert.equal(sim.server.stats.chatRequests, 0)
    assert.equal(sim.companion.state.current, 'IDLE')
    await sim.toggleWiFi()
    assert.equal(sim.companion.wifi.isConnected(), true)
    assert.equal((await sim.chat('online')).ok, true)
  } finally {
    await sim.close()
  }
})

test('AP loss exercises the existing WiFiController reconnect and ERROR states', async () => {
  const { simulator: sim } = await create()
  const observed = []
  sim.companion.wifi.onStatusChanged((state) => observed.push(state))
  try {
    sim.network.setAvailable(false)
    await sim.waitFor(() => observed.includes('ERROR'))
    assert(observed.includes('RECONNECTING'))
    sim.network.setAvailable(true)
    await sim.waitFor(() => sim.companion.wifi.isConnected())
    assert.equal(sim.companion.state.current, 'IDLE')
  } finally {
    await sim.close()
  }
})

test('close during request cancels work, closes sockets and never speaks later', async () => {
  const { simulator: sim, lines } = await create({ latencyMs: 500 })
  const pending = sim.chat('close now')
  try {
    await sim.waitFor(() => sim.server.stats.chatRequests === 1)
  } finally {
    await sim.close()
  }
  assert.equal((await pending).ok, false)
  assert.equal(sim.companion.state.current, 'IDLE')
  assert(!lines.some((line) => line.includes('[SPEAKING]')))
  assert.equal(sim.http.activeRequests.size, 0)
  assert.equal(sim.server.pendingTimers.size, 0)
})

test('rapid input shares one operation budget; response delay keeps THINKING', async () => {
  const { simulator: sim } = await create({ latencyMs: 30 })
  try {
    const pending = sim.chat('one')
    assert.equal(sim.companion.state.current, 'THINKING')
    assert.deepEqual(await sim.chat('two'), { ok: false, code: 'BUSY' })
    assert.deepEqual(await sim.testServer(), { ok: false, code: 'BUSY' })
    assert.equal((await pending).ok, true)
    assert.equal(sim.server.stats.chatRequests, 1)
  } finally {
    await sim.close()
  }
})

test('chat retries preserve body requestId and compute one reply; unknown servers never replay POST', async () => {
  for (const idempotent of [true, false]) {
    const { simulator: sim } = await create({ scenario: '500' })
    sim.conversation.options.idempotentServer = idempotent
    try {
      assert.equal((await sim.chat('你好')).code, 'SERVER_ERROR')
      assert.equal(sim.server.stats.chatRequests, idempotent ? 2 : 1)
      assert.equal(sim.server.stats.repliesComputed, 1)
    } finally {
      await sim.close()
    }
  }
})

test('closing during retry backoff or speaking cancels presentation and cannot enqueue late work', async () => {
  for (const mode of ['backoff', 'speaking']) {
    const { simulator: sim } = await create({
      scenario: mode === 'backoff' ? '500' : '200',
      speakingMs: 500,
      retryDelayMs: 1000,
    })
    const pending = sim.chat('stop')
    try {
      await sim.waitFor(() =>
        mode === 'backoff' ? sim.conversation.cancelWait !== null : sim.companion.state.current === 'SPEAKING',
      )
    } finally {
      await sim.close()
    }
    assert.equal((await pending).ok, false)
    assert.equal(sim.companion.state.current, 'IDLE')
    assert.equal(sim.server.stats.chatRequests, 1)
    assert.equal(sim.robot.motion.torque, false)
  }
})

test('state-entry pose work cannot overwrite a reply action during the speaking hold', async () => {
  const { simulator: sim, lines } = await create({ speakingMs: 500 })
  const pending = sim.chat('look around')
  try {
    await sim.waitFor(() => lines.some((line) => line.includes('[SPEAKING]')))
    assert.equal(sim.companion.motion.task, null)
    assert.deepEqual(sim.robot.motion.gaze, [0.6, -0.15, 0])
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(sim.robot.motion.gaze, [0.6, -0.15, 0])
  } finally {
    await sim.close()
  }
  assert.equal((await pending).ok, false)
})
