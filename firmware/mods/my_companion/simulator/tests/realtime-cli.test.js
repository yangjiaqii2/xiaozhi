import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

test('CLI r/v/i/w/s/x plus retained HTTP/text and q exit complete without hardware', { timeout: 12000 }, async () => {
  const child = spawn(
    process.execPath,
    [
      '--import',
      fileURLToPath(new URL('../register.js', import.meta.url)),
      fileURLToPath(new URL('../index.js', import.meta.url)),
    ],
    {
      env: {
        ...process.env,
        REALTIME_PROVIDER: 'mock',
        MOCK_PORT: '0',
        MOCK_LATENCY_MS: '0',
        MOCK_FIRST_AUDIO_DELAY_MS: '50',
        MOCK_REALTIME_SCENARIO: 'normal',
      },
      stdio: 'pipe',
    },
  )
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    output += chunk.toString()
  })
  const exit = new Promise((resolve, reject) => {
    child.once('exit', resolve)
    child.once('error', reject)
  })
  async function until(fragment, start = 0) {
    const deadline = performance.now() + 3000
    while (!output.slice(start).includes(fragment)) {
      if (performance.now() >= deadline) throw new Error(`Missing ${fragment}; ${output}`)
      await delay(2)
    }
  }
  async function command(value, fragment) {
    const start = output.length
    child.stdin.write(`${value}\n`)
    await until(fragment, start)
  }
  try {
    await until('Commands (press Enter)')
    await command('r', 'connected session=')
    await command('v', 'phase=SPEAKING')
    await command('i', 'phase=INTERRUPTED')
    await until('phase=LISTENING', output.lastIndexOf('phase=INTERRUPTED'))
    await command('w', '[WiFi] DISCONNECTED')
    await command('w', 'connected session=')
    await command('s', '"interruptionCount":1')
    await command('x', '[realtime] stopped')
    await command('t', 'deviceConfig valid')
    await command('c', 'You:')
    await command('你好', '[SPEAKING]')
    await until('SPEAKING → IDLE', output.lastIndexOf('[SPEAKING]'))
    child.stdin.write('q\n')
    assert.equal(await exit, 0)
    assert(output.includes('[Simulator] stopped'))
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 500)
    await exit
    clearTimeout(timer)
  }
})
