import assert from 'node:assert/strict'
import test from 'node:test'
import { loadPersona } from '../app/persona.js'
import { CompanionState, State, stateOrder } from '../app/state.js'

test('state lifecycle reports exit duration before entry and expires to idle', () => {
  let clock = 0
  const events = []
  const state = new CompanionState({
    now: () => clock,
    elapsed: (start, end) => end - start,
    holdMs: 3000,
    onExit: (event) => events.push(['exit', event.state, event.durationMs]),
    onEnter: (event) => events.push(['enter', event.state]),
  })
  state.transition(State.IDLE)
  clock = 100
  state.transition(State.LISTENING)
  assert.equal(state.phase, 'listening')
  clock = 3099
  state.update()
  assert.equal(state.current, State.LISTENING)
  clock = 3100
  state.update()
  assert.equal(state.current, State.IDLE)
  assert.deepEqual(events, [
    ['enter', State.IDLE],
    ['exit', State.IDLE, 100],
    ['enter', State.LISTENING],
    ['exit', State.LISTENING, 3000],
    ['enter', State.IDLE],
  ])
})

test('all states can be selected; invalid and repeated input cannot restart a deadline', () => {
  let clock = 0
  const state = new CompanionState({ now: () => clock, elapsed: (a, b) => b - a, holdMs: 100 })
  for (const value of stateOrder) assert.equal(state.transition(value), true)
  assert.equal(state.transition('constructor'), false)
  clock = 50
  assert.equal(state.transition(State.SURPRISED), false)
  state.currentAction = 'look_up'
  assert.equal(state.currentAction, 'look_up')
  clock = 100
  state.update()
  assert.equal(state.current, State.IDLE)
  assert.equal(state.phase, 'idle')
})

test('persona accepts both server personality shapes and bounds retained data', () => {
  assert.deepEqual(loadPersona(null), {
    name: '',
    personality: [],
    speakingStyle: '',
    voiceId: '',
    initiativeLevel: 0,
  })
  assert.deepEqual(loadPersona({ personality: '温柔、幽默', voiceId: 'voice_001' }).personality, ['温柔、幽默'])
  const persona = loadPersona({
    name: 'x'.repeat(1000),
    personality: Array(50).fill('kind'),
    initiativeLevel: 99,
    voiceId: 12,
    secret: 'do not retain',
  })
  assert.equal(persona.name.length, 64)
  assert.equal(persona.personality.length, 6)
  assert.equal(persona.initiativeLevel, 3)
  assert.equal(persona.voiceId, '')
  assert.equal(persona.secret, undefined)
})
