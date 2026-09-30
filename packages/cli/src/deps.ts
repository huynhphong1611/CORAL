import { android, type DeviceDriver } from '@coral/runner'

export interface DeviceRow {
  udid: string
  state: string
  kind?: 'emulator' | 'real'
  model?: string
  os_version?: string
  api_level?: number
}

export interface RunnableDriver extends DeviceDriver {
  open(): Promise<void>
  close(): Promise<void>
}

/** Everything that touches adb or a device, swapped for fakes in tests. */
export interface CliDeps {
  env: Record<string, string | undefined>
  listDevices(): Promise<DeviceRow[]>
  createDriver(options: { udid: string; appId: string }): Promise<RunnableDriver>
  now(): Date
}

export class AdbMissingError extends Error {
  constructor(adbPath: string) {
    super(`adb not found (${adbPath}); install Android platform-tools or set CORAL_ADB`)
    this.name = 'AdbMissingError'
  }
}

function isEnoent(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true
  }
  return false
}

export function defaultDeps(env: Record<string, string | undefined> = process.env): CliDeps {
  const adbPath = env.CORAL_ADB ?? 'adb'
  return {
    env,
    now: () => new Date(),
    async listDevices() {
      const adb = new android.Adb(adbPath)
      let devices: android.AdbDevice[]
      try {
        devices = await adb.devices()
      } catch (error) {
        if (isEnoent(error)) throw new AdbMissingError(adbPath)
        throw error
      }
      return Promise.all(
        devices.map(async (d): Promise<DeviceRow> => {
          if (d.state !== 'device') return { udid: d.udid, state: d.state }
          const props = await adb.device(d.udid).props()
          return {
            udid: d.udid,
            state: d.state,
            kind: props.emulator ? 'emulator' : 'real',
            model: props.model,
            os_version: props.osVersion,
            api_level: props.apiLevel,
          }
        }),
      )
    },
    createDriver: ({ udid, appId }) =>
      android.createAndroidDriver({
        udid,
        appId,
        adbPath,
        ...(env.CORAL_U2_JAR ? { u2JarPath: env.CORAL_U2_JAR } : {}),
        ...(env.CORAL_CACHE_DIR ? { cacheDir: env.CORAL_CACHE_DIR } : {}),
      }),
  }
}
