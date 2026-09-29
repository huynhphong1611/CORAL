import type { ElementNode, Permission } from '@coral/shared'
import type { DeviceDriver, Point, Size } from '../../core/driver'
import { Adb, AdbError, type AdbDeviceClient } from './adb'
import { parseHierarchy, parseWindowLayers } from './hierarchy'
import { AndroidLifecycle, type InstallRegistry } from './lifecycle'
import { ensureU2Jar } from './u2-assets'
import { U2Server, type Spawner } from './u2-server'

/** u2 UiSelector matching the focused element (contracts/android-u2.md). */
export const FOCUSED_SELECTOR = {
  mask: 0x020000,
  childOrSibling: [],
  childOrSiblingSelector: [],
  focused: true,
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47]

interface DeviceInfo {
  displayWidth: number
  displayHeight: number
}

/** The part of U2Server the driver uses (a fake in unit tests). */
export interface U2Rpc {
  call<T = unknown>(method: string, params?: unknown[], timeoutMs?: number): Promise<T>
  start(): Promise<unknown>
  stop(): Promise<void>
}

/**
 * Android DeviceDriver (SPEC §8.1, D27): UI through the u2 JSON-RPC server, everything else
 * through adb (research R7). Call open() before a run and close() after it.
 */
export class AndroidDriver implements DeviceDriver {
  readonly platform = 'android' as const

  constructor(
    readonly device: AdbDeviceClient,
    private readonly u2: U2Rpc,
    readonly lifecycle: AndroidLifecycle,
  ) {}

  /**
   * The same device and u2 server with the lifecycle bound to `appId`: a device session is opened
   * once and shared by jobs, the live view and remote commands (one u2 per device, research R6).
   */
  forApp(appId: string): AndroidDriver {
    return new AndroidDriver(this.device, this.u2, this.lifecycle.forApp(appId))
  }

  /** Starts the u2 server and turns animations off. */
  async open(): Promise<void> {
    await this.u2.start()
    await this.lifecycle.disableAnimations()
  }

  /** Restores animations (real devices) and stops the u2 server. */
  async close(): Promise<void> {
    await this.lifecycle.restoreAnimations().catch(() => undefined)
    await this.u2.stop()
  }

  // --- UiDriver ------------------------------------------------------------------------------

  async windowSize(): Promise<Size> {
    const info = await this.u2.call<DeviceInfo>('deviceInfo')
    return { width: info.displayWidth, height: info.displayHeight }
  }

  async screenshot(): Promise<Uint8Array> {
    const png = new Uint8Array(await this.device.execOut(['screencap', '-p']))
    if (!PNG_SIGNATURE.every((byte, i) => png[i] === byte)) {
      throw new AdbError('screencap did not return a PNG')
    }
    return png
  }

  /** The u2 dump, with windows in the window manager's z-order (read alongside, research R5). */
  async tree(): Promise<ElementNode[]> {
    const [xml, layers] = await Promise.all([
      this.u2.call<string>('dumpWindowHierarchy', [false, 50]),
      this.device.shell(['dumpsys', 'window', 'windows']).then(parseWindowLayers, () => undefined),
    ])
    return parseHierarchy(xml, layers)
  }

  async tapAt(point: Point): Promise<void> {
    await this.u2.call('click', [point.x, point.y])
  }

  async longPressAt(point: Point, ms: number): Promise<void> {
    await this.u2.call('click', [point.x, point.y, ms])
  }

  /** Sets the focused field's text (UiObject.setText: Unicode-safe, replaces the content). */
  async type(text: string): Promise<void> {
    await this.u2.call('setText', [FOCUSED_SELECTOR, text])
  }

  async clearText(): Promise<void> {
    await this.u2.call('clearTextField', [FOCUSED_SELECTOR])
  }

  async swipe(from: Point, to: Point, ms: number): Promise<void> {
    // One u2 swipe step takes about 5 ms.
    const steps = Math.max(1, Math.round(ms / 5))
    await this.u2.call('swipe', [from.x, from.y, to.x, to.y, steps])
  }

  async back(): Promise<void> {
    await this.u2.call('pressKey', ['back'])
  }

  async hideKeyboard(): Promise<void> {
    const ime = await this.device.shell(['dumpsys', 'input_method'])
    if (/mInputShown=true/.test(ime)) await this.u2.call('pressKey', ['back'])
  }

  // --- TargetLifecycle -----------------------------------------------------------------------

  launch(appId: string): Promise<void> {
    return this.lifecycle.launch(appId)
  }
  openDeepLink(url: string): Promise<void> {
    return this.lifecycle.openDeepLink(url)
  }
  install(buildPath: string, sha256: string): Promise<void> {
    return this.lifecycle.install(buildPath, sha256)
  }
  resetApp(appId: string): Promise<void> {
    return this.lifecycle.resetApp(appId)
  }
  grantPermissions(appId: string, permissions: readonly Permission[]): Promise<void> {
    return this.lifecycle.grantPermissions(appId, permissions)
  }
  isAppRunning(appId: string): Promise<boolean> {
    return this.lifecycle.isAppRunning(appId)
  }
  deviceLogs(sinceMs: number): Promise<string> {
    return this.lifecycle.deviceLogs(sinceMs)
  }
  systemDialogOwner(): Promise<string | undefined> {
    return this.lifecycle.systemDialogOwner()
  }
}

export interface CreateAndroidDriverOptions {
  udid: string
  /** Package under test; leave it out for a device session and use forApp() per job. */
  appId?: string
  adbPath?: string
  /** `CORAL_U2_JAR` */
  u2JarPath?: string
  /** `CORAL_CACHE_DIR` */
  cacheDir?: string
  registry?: InstallRegistry
  spawner?: Spawner
}

/** Wires adb, the verified u2.jar, the u2 server and the lifecycle for one device. */
export async function createAndroidDriver(
  options: CreateAndroidDriverOptions,
): Promise<AndroidDriver> {
  const adb = new Adb(options.adbPath ?? 'adb')
  const device = adb.device(options.udid)
  const props = await device.props()
  const jarPath = await ensureU2Jar({
    ...(options.u2JarPath ? { jarPath: options.u2JarPath } : {}),
    ...(options.cacheDir ? { cacheDir: options.cacheDir } : {}),
  })
  const u2 = new U2Server(device, {
    jarPath,
    ...(options.spawner ? { spawner: options.spawner } : {}),
  })
  const lifecycle = new AndroidLifecycle(device, {
    ...(options.appId !== undefined ? { appId: options.appId } : {}),
    apiLevel: props.apiLevel,
    emulator: props.emulator,
    ...(options.registry ? { registry: options.registry } : {}),
  })
  return new AndroidDriver(device, u2, lifecycle)
}
