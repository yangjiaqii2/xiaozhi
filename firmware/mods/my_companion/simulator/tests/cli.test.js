import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

test('desktop CLI starts its own server and accepts t/c/w/s/q without hardware', { timeout: 10000 }, async () => {
  const root = new URL('../../../../', import.meta.url)
  const child = spawn(
    process.execPath,
    [
      '--import',
      fileURLToPath(new URL('../register.js', import.meta.url)),
      fileURLToPath(new URL('../index.js', import.meta.url)),
    ],
    {
      cwd: fileURLToPath(root),
      env: { ...process.env, REALTIME_PROVIDER: 'mock', MOCK_PORT: '0', MOCK_LATENCY_MS: '0', MOCK_SCENARIO: '200' },
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
    child.once('exit', (code) => resolve(code))
    child.once('error', reject)
  })
  async function until(fragment, start = 0) {
    const deadline = performance.now() + 3000
    while (!output.slice(start).includes(fragment)) {
      if (performance.now() > deadline) throw new Error(`Missing ${fragment}; output=${output}`)
      await delay(5)
    }
  }
  try {
    await until('Commands (press Enter)')
    child.stdin.write('t\n')
    await until('deviceConfig valid')
    child.stdin.write('c\n')
    await until('You:')
    child.stdin.write('你今天怎么样？\n')
    await until('[SPEAKING]')
    await until('SPEAKING → IDLE')
    let offset = output.length
    child.stdin.write('w\n')
    await until('[WiFi] DISCONNECTED', offset)
    offset = output.length
    child.stdin.write('w\n')
    await until('[WiFi] CONNECTED', offset)
    offset = output.length
    child.stdin.write('s\n')
    await until('"state":"IDLE"', offset)
    child.stdin.write('q\n')
    assert.equal(await exit, 0)
    assert(output.includes('[Simulator] stopped'))
  } finally {
    const deadline = setTimeout(() => child.kill('SIGKILL'), 500)
    if (child.exitCode === null) child.kill('SIGTERM')
    try {
      await exit
    } finally {
      clearTimeout(deadline)
    }
  }
})
