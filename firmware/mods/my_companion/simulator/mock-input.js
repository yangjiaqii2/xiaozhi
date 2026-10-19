import readline from 'node:readline'

// Line-based keyboard input works in terminals, pipes and automated child processes.
export class KeyboardInput {
  constructor(simulator, { input = process.stdin, output = process.stdout } = {}) {
    this.simulator = simulator
    this.input = input
    this.output = output
    this.awaitingText = false
    this.closing = false
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve
    })
    this.signal = () => {
      void this.close()
    }
  }

  start() {
    this.output.write(
      'Stack-chan Simulator\nCommands (press Enter):\nt  Test server\nc  Chat\nr  Realtime connect\nv  Voice stream fixture\ni  Interrupt\nx  Stop realtime (return to HTTP/text)\nw  Toggle Wi-Fi\ns  Show state\nq  Quit\n',
    )
    this.showState()
    this.readline = readline.createInterface({
      input: this.input,
      output: this.output,
      terminal: Boolean(this.input.isTTY),
    })
    this.readline.on('line', (line) => this.line(line))
    this.readline.on('close', this.signal)
    this.readline.on('SIGINT', this.signal)
    process.once('SIGINT', this.signal)
    process.once('SIGTERM', this.signal)
    return this.done
  }

  line(line) {
    if (this.closing) return
    const command = line.trim()
    if (command === 'q') {
      void this.close()
      return
    }
    if (this.awaitingText) {
      this.awaitingText = false
      this.run(() => this.simulator.chat(line))
      return
    }
    switch (command) {
      case 'r':
        this.run(() => this.simulator.connectRealtime())
        break
      case 'v':
        this.run(() => this.simulator.voice())
        break
      case 'i':
        this.run(() => this.simulator.interrupt())
        break
      case 'x':
        this.run(() => this.simulator.stopRealtime())
        break
      case 't':
        this.run(() => this.simulator.testServer())
        break
      case 'c':
        if (this.simulator.companion.apiTest) {
          this.output.write('[Input] BUSY\n')
          break
        }
        this.awaitingText = true
        this.output.write('You:\n')
        break
      case 'w':
        if (!this.wifiTask) {
          this.wifiTask = this.run(() => this.simulator.toggleWiFi()).finally(() => {
            this.wifiTask = null
          })
        }
        break
      case 's':
        this.showState()
        break
      case '':
        break
      default:
        this.output.write('[Input] Use t/c/r/v/i/x/w/s/q (then Enter)\n')
    }
  }

  showState() {
    this.output.write(`[Simulator] ${JSON.stringify(this.simulator.snapshot())}\n`)
  }

  async run(operation) {
    try {
      const result = await operation()
      if (!this.closing && result?.ok === false) this.output.write(`[Input] ${result.code ?? 'REQUEST_FAILED'}\n`)
    } catch {
      if (!this.closing) this.output.write('[Input] COMMAND_ERROR\n')
    }
  }

  async close() {
    if (this.closing) return
    this.closing = true
    process.off('SIGINT', this.signal)
    process.off('SIGTERM', this.signal)
    this.readline?.close()
    this.input.pause()
    this.input.unref?.()
    try {
      await this.simulator.close()
    } finally {
      this.output.write('[Simulator] stopped\n')
      this.resolveDone()
    }
  }
}
