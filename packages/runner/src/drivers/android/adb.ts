import { execFile } from 'node:child_process'

/** Runs a binary and returns stdout; rejects on non-zero exit or timeout. */
export type ExecFn = (
  file: string,
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<Buffer>

export const defaultExec: ExecFn = (file, args, { timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: timeoutMs, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.toString('utf8').trim() || stdout.toString('utf8').trim()
          reject(new AdbError(`${file} ${args.join(' ')}: ${detail || error.message}`, error))
        } else {
          resolve(stdout)
        }
      },
    )
  })

export class AdbError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'AdbError'
  }
}

export const ADB_TIMEOUT_MS = 30_000

/** Quotes one word for the device's `sh`; plain words stay as they are. */
export function shellQuote(word: string): string {
  if (/^[\w@%+=:,./-]+$/.test(word)) return word
  return `'${word.replace(/'/g, `'\\''`)}'`
}

/** `device`, `offline`, `unauthorized`, `recovery`… as printed by adb. */
export type AdbState = string

export interface AdbDevice {
  udid: string
  state: AdbState
  model?: string
  transportId?: string
}

/** Parses `adb devices -l`. */
export function parseDevices(output: string): AdbDevice[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('List of devices') && !line.startsWith('*'))
    .map((line) => {
      const [udid = '', state = '', ...rest] = line.split(/\s+/)
      const fields = Object.fromEntries(
        rest.filter((part) => part.includes(':')).map((part) => part.split(/:(.*)/s, 2)),
      ) as Record<string, string>
      return {
        udid,
        state,
        ...(fields.model ? { model: fields.model } : {}),
        ...(fields.transport_id ? { transportId: fields.transport_id } : {}),
      }
    })
}

export interface DeviceProps {
  model: string
  osVersion: string
  apiLevel: number
  emulator: boolean
}

/** Thin, testable wrapper over the adb binary (research R7). */
export class Adb {
  constructor(
    readonly path = 'adb',
    private readonly exec: ExecFn = defaultExec,
  ) {}

  async raw(args: readonly string[], timeoutMs = ADB_TIMEOUT_MS): Promise<Buffer> {
    return this.exec(this.path, args, { timeoutMs })
  }

  async text(args: readonly string[], timeoutMs = ADB_TIMEOUT_MS): Promise<string> {
    return (await this.raw(args, timeoutMs)).toString('utf8')
  }

  async version(): Promise<string> {
    const out = await this.text(['version'], 10_000)
    return /version ([\d.]+)/.exec(out)?.[1] ?? out.split('\n')[0] ?? ''
  }

  async devices(): Promise<AdbDevice[]> {
    return parseDevices(await this.text(['devices', '-l'], 10_000))
  }

  device(udid: string): AdbDeviceClient {
    return new AdbDeviceClient(this, udid)
  }
}

/** Commands for one device (`adb -s <udid> …`). */
export class AdbDeviceClient {
  constructor(
    readonly adb: Adb,
    readonly udid: string,
  ) {}

  private args(rest: readonly string[]): string[] {
    return ['-s', this.udid, ...rest]
  }

  /**
   * `adb shell` with arguments as separate words. adb joins them for the device shell, so every
   * word is quoted there (URLs with `&`, text with spaces cannot inject commands).
   */
  shell(command: readonly string[], timeoutMs?: number): Promise<string> {
    return this.adb.text(this.args(['shell', ...command.map(shellQuote)]), timeoutMs)
  }

  /** Binary-safe stdout (screencap). */
  execOut(command: readonly string[], timeoutMs?: number): Promise<Buffer> {
    return this.adb.raw(this.args(['exec-out', ...command]), timeoutMs)
  }

  push(local: string, remote: string): Promise<string> {
    return this.adb.text(this.args(['push', local, remote]), 120_000)
  }

  install(apk: string): Promise<string> {
    // -r replace, -d allow downgrade; never -g: permission popups must stay testable (R7).
    return this.adb.text(this.args(['install', '-r', '-d', apk]), 300_000)
  }

  forward(localPort: number, remotePort: number): Promise<string> {
    return this.adb.text(this.args(['forward', `tcp:${localPort}`, `tcp:${remotePort}`]))
  }

  /** Lets adb pick a free local port; returns it. */
  async forwardAny(remotePort: number): Promise<number> {
    const out = await this.adb.text(this.args(['forward', 'tcp:0', `tcp:${remotePort}`]))
    const port = Number(out.trim())
    if (!Number.isInteger(port) || port <= 0)
      throw new AdbError(`unexpected forward output: ${out}`)
    return port
  }

  removeForward(localPort: number): Promise<string> {
    return this.adb.text(this.args(['forward', '--remove', `tcp:${localPort}`]))
  }

  async getprop(name: string): Promise<string> {
    return (await this.shell(['getprop', name])).trim()
  }

  async props(): Promise<DeviceProps> {
    const [model, osVersion, sdk, qemu, characteristics] = await Promise.all([
      this.getprop('ro.product.model'),
      this.getprop('ro.build.version.release'),
      this.getprop('ro.build.version.sdk'),
      this.getprop('ro.kernel.qemu'),
      this.getprop('ro.build.characteristics'),
    ])
    return {
      model,
      osVersion,
      apiLevel: Number(sdk) || 0,
      emulator:
        this.udid.startsWith('emulator-') || qemu === '1' || characteristics.includes('emulator'),
    }
  }
}
