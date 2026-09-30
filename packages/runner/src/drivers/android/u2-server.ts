import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { AdbDeviceClient } from './adb'
import { U2Client, U2RpcError, U2TransportError } from './u2-client'

export const U2_DEVICE_PORT = 9008
export const U2_REMOTE_JAR = '/data/local/tmp/u2.jar'
export const U2_READY_TIMEOUT_MS = 30_000
export const U2_LAUNCH = `CLASSPATH=${U2_REMOTE_JAR} app_process / com.wetest.uia2.Main -p ${U2_DEVICE_PORT}`

export class U2StartError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'U2StartError'
  }
}

/** A long-running `adb shell` process (the u2 server); injectable for tests. */
export interface ServerProcess {
  output(): string
  exited(): boolean
  kill(): void
}

export type Spawner = (adbPath: string, args: string[]) => ServerProcess

export const defaultSpawner: Spawner = (adbPath, args) => {
  const child = spawn(adbPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let done = false
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')))
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')))
  child.on('exit', () => (done = true))
  child.on('error', (error) => {
    output += `\n${error.message}`
    done = true
  })
  return { output: () => output, exited: () => done, kill: () => void child.kill() }
}

export interface U2ServerOptions {
  jarPath: string
  spawner?: Spawner
  fetch?: typeof fetch
  readyTimeoutMs?: number
  pollMs?: number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Owns the u2 server of one device: pushes the jar when its md5 differs, starts `app_process`,
 * forwards a local port, waits until it answers, and restarts it once when the instrumentation
 * dies (contracts/android-u2.md).
 */
export class U2Server {
  private process: ServerProcess | undefined
  private localPort: number | undefined
  private client: U2Client | undefined

  constructor(
    private readonly device: AdbDeviceClient,
    private readonly options: U2ServerOptions,
  ) {}

  private async jarUpToDate(): Promise<boolean> {
    const local = createHash('md5')
      .update(await readFile(this.options.jarPath))
      .digest('hex')
    let remote: string
    try {
      remote = await this.device.shell(['toybox', 'md5sum', U2_REMOTE_JAR])
      if (/not found/.test(remote)) remote = await this.device.shell(['md5', U2_REMOTE_JAR])
    } catch {
      return false
    }
    return remote.includes(local)
  }

  /** Starts (or reuses) the server; returns a ready client. */
  async start(): Promise<U2Client> {
    if (this.client && (await this.client.ping())) return this.client
    if (!(await this.jarUpToDate())) await this.device.push(this.options.jarPath, U2_REMOTE_JAR)

    this.localPort ??= await this.device.forwardAny(U2_DEVICE_PORT)
    const client = new U2Client(`http://127.0.0.1:${this.localPort}`, {
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    })
    if (await client.ping()) {
      // A server we started earlier is still running on the device.
      this.client = client
      return client
    }

    const spawner = this.options.spawner ?? defaultSpawner
    this.process = spawner(this.device.adb.path, ['-s', this.device.udid, 'shell', U2_LAUNCH])
    const readyMs = this.options.readyTimeoutMs ?? U2_READY_TIMEOUT_MS
    const deadline = Date.now() + readyMs
    while (Date.now() < deadline) {
      const output = this.process.output()
      if (output.includes('already registered')) {
        this.process.kill()
        throw new U2StartError(
          'another UiAutomation client is running on the device (Appium, uiautomator, another ' +
            'coral agent). Stop it, e.g. `adb shell am force-stop io.appium.uiautomator2.server`, ' +
            'then retry.',
        )
      }
      if (this.process.exited()) {
        throw new U2StartError(`u2 server exited during start:\n${output.slice(-2000)}`)
      }
      if (await client.ping(1000)) {
        this.client = client
        return client
      }
      await sleep(this.options.pollMs ?? 500)
    }
    this.process.kill()
    throw new U2StartError(`u2 server did not become ready within ${readyMs / 1000} s`)
  }

  async stop(): Promise<void> {
    this.process?.kill()
    this.process = undefined
    this.client = undefined
    if (this.localPort !== undefined) {
      await this.device.removeForward(this.localPort).catch(() => undefined)
      this.localPort = undefined
    }
  }

  /** JSON-RPC call; on a dead instrumentation or a dropped connection, restarts once and retries. */
  async call<T = unknown>(method: string, params: unknown[] = [], timeoutMs?: number): Promise<T> {
    const client = await this.start()
    try {
      return await client.call<T>(method, params, timeoutMs)
    } catch (error) {
      const recoverable =
        error instanceof U2TransportError || (error instanceof U2RpcError && error.needsRestart)
      if (!recoverable) throw error
      this.process?.kill()
      this.process = undefined
      this.client = undefined
      // Wait for the old server to go away so start() does not reuse it (up to 10 s).
      const gone = Date.now() + 10_000
      while (Date.now() < gone && (await client.ping(500))) await sleep(this.options.pollMs ?? 500)
      return (await this.start()).call<T>(method, params, timeoutMs)
    }
  }
}
