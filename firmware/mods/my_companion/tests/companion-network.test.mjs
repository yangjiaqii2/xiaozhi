import assert from 'node:assert/strict'
import test from 'node:test'
import { Companion } from 'my-companion/companion'
import config from 'my-companion/config'
import { State } from 'my-companion/state'
import { Clock, httpRuntime, response } from './helpers/network.mjs'

function fixture(script) {
  const clock = new Clock()
  const native = { state: 4 }
  const callbacks = new Map()
  const prior = () => {}
  const robot = {
    connectivity: { network: { ready: Promise.resolve({ status: 'connected' }) } },
    input: { button: { power: { onEvent: prior } } },
    face: { setEmotion() {} },
    motion: { lookAway() {}, async setTorque() {}, async setPose() {} },
    ui: {
      showBalloon() {},
      hideBalloon() {},
      closeDrawer() {},
      drawer: {
        addDrawerButton(spec) {
          callbacks.set(spec.key, spec.callback)
        },
        removeDrawerButton(key) {
          callbacks.delete(key)
        },
      },
    },
  }
  const runtime = httpRuntime(clock, [script])
  const companion = new Companion(
    robot,
    {
      ...config,
      server: { ...config.server, baseUrl: 'http://example.test', retry: { enabled: false } },
      network: { ...config.network, pollMs: 10, reconnect: { ...config.network.reconnect, enabled: false } },
      simulation: { holdMs: 10, tickMs: 2 },
      debug: { enabled: false },
      motion: { ...config.motion, enabled: false },
    },
    {
      httpRuntime: runtime,
      networkRuntime: {
        get: () => native,
        start() {
          throw new Error('healthy connection must not restart')
        },
        stop() {},
        credentials: () => ({ ssid: '' }),
        states: { CONNECTED: 4 },
        timer: clock,
        now: clock.now,
        elapsed: clock.elapsed,
      },
    },
  )
  companion.start()
  return { companion, robot, callbacks, runtime, clock, prior }
}

test('power and drawer share one request; THINKING spans full request; config is validated without applying persona', async () => {
  const f = fixture(response(200, '{"deviceId":"r","persona":{"name":"远端人格"},"features":{"vision":true}}'))
  try {
    assert.equal(f.companion.networkStatus, 'CONNECTED')
    assert.equal(f.companion.state.current, State.IDLE, 'network connection must not change emotion')
    f.robot.input.button.power.onEvent({ pressed: false })
    assert.equal(f.runtime.requests.length, 0)
    f.robot.input.button.power.onEvent({ pressed: true })
    const pending = f.companion.apiTest
    f.callbacks.get('my-companion:test-server')()
    assert.equal(f.runtime.requests.length, 1)
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(f.companion.state.current, State.THINKING, 'simulation deadline cannot end an API request early')
    f.clock.advance(0)
    assert.equal((await pending).ok, true)
    assert.equal(f.companion.state.current, State.IDLE)
    assert.equal(f.companion.persona.name, '')
    assert.equal(f.companion.config.features.vision, false)
  } finally {
    await f.companion.close()
  }
  assert.equal(f.robot.input.button.power.onEvent, f.prior)
  assert.equal(f.callbacks.size, 0)
  assert.equal(f.clock.tasks.size, 0)
})

for (const script of [response(200, '{"persona":{}}'), response(401), () => {}]) {
  test('protocol/auth/timeout failure returns IDLE without unhandled errors', async () => {
    const f = fixture(script)
    try {
      const pending = f.companion.testServer()
      f.clock.advance(config.server.timeoutMs)
      assert.equal((await pending).ok, false)
      assert.equal(f.companion.state.current, State.IDLE)
    } finally {
      await f.companion.close()
    }
  })
}

test('stop cancels a pending request and cannot restore a stale THINKING state', async () => {
  const f = fixture(() => {})
  const pending = f.companion.testServer()
  await f.companion.close()
  assert.equal((await pending).ok, false)
  assert.equal(f.companion.state.current, State.IDLE)
  assert.equal(f.clock.tasks.size, 0)
})
