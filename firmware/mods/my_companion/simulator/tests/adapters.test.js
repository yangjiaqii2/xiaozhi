import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { Emotion } from 'face-state'
import { ApiClient } from 'my-companion/api-client'
import { FaceController } from 'my-companion/face'
import { validateDeviceConfig, validateHealthResponse } from '../../ai/protocol.js'
import { simulatorConfig } from '../config.js'
import { createMockHTTP } from '../mock-http.js'
import { MockRobot } from '../mock-robot.js'
import { MockServer } from '../mock-server.js'
import { MockPresentation } from '../presentation.js'

const quiet = { debug() {}, error() {} }
const connected = { isConnected: () => true, onStatusChanged: () => () => {} }

test('MockRobot provides only used capability boundaries and preserves input/UI/face/motion state', async () => {
  const lines = []
  const robot = new MockRobot({ write: (line) => lines.push(line), ready: Promise.resolve({ status: 'connected' }) })
  const presses = []
  robot.input.button.power.onEvent = (event) => presses.push(event.pressed)
  robot.input.pressPower()
  assert.deepEqual(presses, [true, false])
  robot.face.setEmotion(Emotion.HAPPY)
  assert.equal(robot.face.emotion, 'HAPPY')
  robot.face.setEmotion(1000)
  assert.equal(robot.face.emotion, 'NEUTRAL')
  robot.ui.showBalloon('hello')
  assert.equal(robot.balloon, 'hello')
  robot.ui.hideBalloon()
  assert.equal(robot.balloon, null)
  let called = false
  robot.ui.drawer.addDrawerButton({
    key: 'test',
    callback: () => {
      called = true
    },
  })
  robot.drawer.get('test')()
  assert(called)
  robot.ui.drawer.removeDrawerButton('test')
  assert.equal(robot.drawer.size, 0)
  await robot.motion.setTorque(true)
  await robot.motion.setPose({ rotation: { y: 0.05, p: 0, r: 0 } })
  assert.equal(robot.motion.torque, true)
  assert.equal(robot.motion.pose.rotation.y, 0.05)
  assert(lines.some((line) => line.includes('[MOTION] pose=')))
})

test('presentation supports look_away, ignores arbitrary action names, and cancels speaking hold', async () => {
  const lines = []
  const robot = new MockRobot({ write: (line) => lines.push(line), ready: Promise.resolve() })
  const companion = { robot, face: new FaceController(robot.face, quiet) }
  const presentation = new MockPresentation(companion, (line) => lines.push(line), 1)
  robot.motion.lookAt([1, 0, 0])
  const reply = { text: '你好', emotion: 'sad', action: 'look_away', voiceId: 'default' }
  await presentation.reply(reply)
  assert.equal(robot.motion.gaze, null)
  assert.equal(robot.face.emotion, 'SAD')
  for (const action of ['__proto__', 'constructor', 'close', 'setTorque', 'eval("bad")']) {
    await presentation.reply({ ...reply, action })
  }
  assert.equal(robot.motion.torque, false)
  assert.equal(lines.filter((line) => line.includes('ignored action=')).length, 5)
  const speaking = presentation.reply(reply)
  const rejected = assert.rejects(speaking, { code: 'CANCELLED' })
  presentation.close()
  await rejected
})

test('MockHTTP connects only to loopback and releases native requests', async () => {
  const runtime = createMockHTTP()
  assert.throws(() => new runtime.Request({ host: 'example.com' }), /LOOPBACK_HTTP_ONLY/)
  const server = await new MockServer({ port: 0, latencyMs: 0 }).start()
  const client = new ApiClient(
    { ...simulatorConfig().server, baseUrl: server.baseUrl },
    connected,
    runtime,
    quiet,
    quiet,
  )
  try {
    assert.equal(validateHealthResponse((await client.get('/api/health')).data).status, 'ok')
    assert.equal(validateDeviceConfig((await client.get('/api/device/config')).data).deviceId, 'robot-001')
    await assert.rejects(client.get('/not-found'), { status: 404 })
    assert.equal(runtime.activeRequests.size, 0)
  } finally {
    client.close()
    await server.close()
  }
})

test('MockServer validates chat, deduplicates requestId and bounds its reply cache', async () => {
  const server = await new MockServer({ port: 0, latencyMs: 0 }).start()
  const runtime = createMockHTTP()
  const client = new ApiClient(
    { ...simulatorConfig().server, baseUrl: server.baseUrl },
    connected,
    runtime,
    quiet,
    quiet,
  )
  const body = { deviceId: 'robot-001', requestId: 'same-request', text: '你好' }
  try {
    const first = (await client.post('/api/chat', body)).data
    assert.deepEqual((await client.post('/api/chat', body)).data, first)
    assert.equal(server.stats.repliesComputed, 1)
    await assert.rejects(client.post('/api/chat', { ...body, text: 'different' }), { status: 400 })
    await assert.rejects(client.post('/api/chat', { text: 'missing fields' }), { status: 400 })
    for (let i = 0; i < 100; i++)
      server.route('POST', '/api/chat', Buffer.from(JSON.stringify({ ...body, requestId: `req-${i}` })))
    assert(server.cache.size <= 32)
  } finally {
    client.close()
    await server.close()
  }
})

test('MockServer rejects malformed and oversized request bodies without crashing', async () => {
  const server = await new MockServer({ port: 0, latencyMs: 0 }).start()
  try {
    for (const [body, status] of [
      ['{broken', 400],
      ['x'.repeat(9000), 413],
    ]) {
      const actual = await new Promise((resolve, reject) => {
        const request = http.request(`${server.baseUrl}/api/chat`, { method: 'POST' }, (response) => {
          response.resume()
          response.on('end', () => resolve(response.statusCode))
        })
        request.on('error', reject)
        request.end(body)
      })
      assert.equal(actual, status)
    }
  } finally {
    await server.close()
  }
})
