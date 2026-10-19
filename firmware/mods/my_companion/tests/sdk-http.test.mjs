import assert from 'node:assert/strict'
import test from 'node:test'
import { Request } from 'companion-sdk-http'
import { ApiClient } from 'my-companion/api-client'
import { logger } from './helpers/network.mjs'
import { Socket } from './helpers/sdk-socket.mjs'

const options = {
  baseUrl: 'http://sdk-contract.test',
  timeoutMs: 100,
  maxResponseBytes: 128,
  maxRequestBytes: 128,
  retry: { enabled: false },
  deviceId: '',
  token: '',
}
const wifi = { isConnected: () => true, onStatusChanged: () => () => {} }
const runtime = {
  Request,
  URL,
  TextDecoder,
  now: () => 1,
  timer: {
    set: (callback, ms) => setTimeout(callback, ms),
    clear: (id) => clearTimeout(id),
  },
}

test('unmodified SDK Request delivers fixed, chunked and close-delimited UTF-8 through the bounded client', async () => {
  const body = new TextEncoder().encode('{"deviceId":"小七"}')
  const scripts = [
    (socket) => {
      socket.feed(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n`)
      socket.feed(body.slice(0, 15))
      socket.feed(body.slice(15))
    },
    (socket) => {
      socket.feed('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n')
      socket.feed(`${body.length.toString(16)}\r\n`)
      for (const byte of body) socket.feed(new Uint8Array([byte]))
      socket.feed('\r\n0\r\n\r\n')
    },
    (socket) => {
      socket.feed('HTTP/1.1 200 OK\r\n\r\n')
      socket.feed(body)
      socket.callback(-1)
    },
  ]
  for (const script of scripts) {
    Socket.scripts.push(script)
    const client = new ApiClient(options, wifi, runtime, logger, logger)
    try {
      assert.deepEqual((await client.get('/test')).data, { deviceId: '小七' })
      assert.equal(Socket.instances.at(-1).closed, true)
    } finally {
      client.close()
    }
  }
})

test('unmodified SDK Request permits early close for HTTP errors and oversized headers/body', async () => {
  for (const [payload, code] of [
    ['HTTP/1.1 401 Unauthorized\r\nContent-Length: 5\r\n\r\nerror', 'AUTH_ERROR'],
    ['HTTP/1.1 200 OK\r\nContent-Length: 9999999\r\n\r\n', 'RESPONSE_TOO_LARGE'],
    [
      `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n100\r\n${'x'.repeat(256)}\r\n0\r\n\r\n`,
      'RESPONSE_TOO_LARGE',
    ],
  ]) {
    Socket.scripts.push((socket) => socket.feed(payload))
    const client = new ApiClient(options, wifi, runtime, logger, logger)
    try {
      await assert.rejects(client.get('/test'), { code })
    } finally {
      client.close()
    }
    assert.equal(Socket.instances.at(-1).closed, true)
  }
})
