import { androidPermissions, type Permission } from '@coral/shared'
import { realClock, type Clock } from '../../core/clock'
import type { ForegroundActivity, TargetLifecycle } from '../../core/driver'
import { AdbError, type AdbDeviceClient } from './adb'

const PACKAGE = /^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/
const SYSTEM_DIALOG_TITLE =
  /Application (?:Not Responding|Error): ([A-Za-z][\w]*(?:\.[A-Za-z_][\w]*)+)/

function assertPackage(appId: string): string {
  if (!PACKAGE.test(appId)) throw new AdbError(`invalid Android package name: ${appId}`)
  return appId
}

/** resetApp polls `dumpsys activity` this often, at most this many times, after the stop. */
export const STOP_POLL_MS = 100
export const STOP_POLLS = 50

export const ANIMATION_SETTINGS = [
  'window_animation_scale',
  'transition_animation_scale',
  'animator_duration_scale',
] as const

/** Remembers the sha256 installed on each device so unchanged builds are not reinstalled. */
export interface InstallRegistry {
  get(udid: string, appId: string): string | undefined
  set(udid: string, appId: string, sha256: string): void
}

export class MemoryInstallRegistry implements InstallRegistry {
  private readonly installed = new Map<string, string>()
  get(udid: string, appId: string) {
    return this.installed.get(`${udid}/${appId}`)
  }
  set(udid: string, appId: string, sha256: string) {
    this.installed.set(`${udid}/${appId}`, sha256)
  }
}

export interface AndroidLifecycleOptions {
  /**
   * Package under test; install(), openDeepLink() and crashedSince() need it. A device session
   * without an app (live view) leaves it out and binds one later with forApp().
   */
  appId?: string
  apiLevel: number
  emulator: boolean
  registry?: InstallRegistry
  /** Waits between polls; tests pass a fake one. */
  clock?: Clock
}

/**
 * Device preparation with adb (§8.3, §9.1, research R7). Only the package under test and the
 * animation settings are touched (P6); animation values are restored on real devices.
 */
export class AndroidLifecycle implements TargetLifecycle {
  private savedAnimations: Record<string, string> | undefined
  private readonly registry: InstallRegistry

  constructor(
    private readonly device: AdbDeviceClient,
    private readonly options: AndroidLifecycleOptions,
  ) {
    if (options.appId !== undefined) assertPackage(options.appId)
    this.registry = options.registry ?? new MemoryInstallRegistry()
  }

  /** The same device and install registry, for another package under test. */
  forApp(appId: string): AndroidLifecycle {
    return new AndroidLifecycle(this.device, { ...this.options, appId, registry: this.registry })
  }

  private app(): string {
    if (this.options.appId === undefined)
      throw new AdbError('no app under test for this device session')
    return this.options.appId
  }

  async install(buildPath: string, sha256: string): Promise<void> {
    const appId = this.app()
    if (this.registry.get(this.device.udid, appId) === sha256) return
    const out = await this.device.install(buildPath)
    if (!/Success/.test(out)) throw new AdbError(`install failed: ${out.trim()}`)
    this.registry.set(this.device.udid, appId, sha256)
  }

  /**
   * Clears the app's data. When `pm clear` removes the task of an activity still on screen,
   * Android kills the package's processes one second later (KILL_TASK_PROCESSES_TIMEOUT_MS in
   * ActivityTaskSupervisor) — also the process of a launch that came in between, which then never
   * shows (seen on the CI emulator). Stopping the app first and waiting until the activity manager
   * has dropped its activities makes that kill happen at once, before any launch.
   */
  async resetApp(appId: string): Promise<void> {
    const pkg = assertPackage(appId)
    await this.stopApp(pkg)
    const activity = new RegExp(`ActivityRecord\\{\\S+ u\\d+ ${pkg.replaceAll('.', '\\.')}/`)
    const clock = this.options.clock ?? realClock
    // Up to 5 s; after that the data is cleared all the same.
    for (let poll = 0; poll < STOP_POLLS; poll += 1) {
      if (!activity.test(await this.device.shell(['dumpsys', 'activity', 'activities']))) break
      await clock.sleep(STOP_POLL_MS)
    }
    const out = await this.device.shell(['pm', 'clear', pkg])
    if (!/Success/.test(out)) throw new AdbError(`pm clear ${appId} failed: ${out.trim()}`)
  }

  /** Stops the app (`am force-stop`), keeping its data: "restart app" from the live view. */
  async stopApp(appId: string): Promise<void> {
    await this.device.shell(['am', 'force-stop', assertPackage(appId)])
  }

  async grantPermissions(appId: string, permissions: readonly Permission[]): Promise<void> {
    assertPackage(appId)
    for (const permission of permissions) {
      for (const name of androidPermissions(permission, this.options.apiLevel)) {
        await this.device.shell(['pm', 'grant', appId, name])
      }
    }
  }

  /** Sets the three animation scales to 0, remembering the previous values. */
  async disableAnimations(): Promise<void> {
    if (!this.savedAnimations) {
      const saved: Record<string, string> = {}
      for (const key of ANIMATION_SETTINGS) {
        saved[key] = (await this.device.shell(['settings', 'get', 'global', key])).trim()
      }
      this.savedAnimations = saved
    }
    for (const key of ANIMATION_SETTINGS) {
      await this.device.shell(['settings', 'put', 'global', key, '0'])
    }
  }

  /** Puts animation values back on real devices (emulators stay fast). */
  async restoreAnimations(): Promise<void> {
    const saved = this.savedAnimations
    this.savedAnimations = undefined
    if (!saved || this.options.emulator) return
    for (const key of ANIMATION_SETTINGS) {
      const value = saved[key]
      if (value === undefined || value === 'null' || value === '') {
        await this.device.shell(['settings', 'delete', 'global', key])
      } else {
        await this.device.shell(['settings', 'put', 'global', key, value])
      }
    }
  }

  async launch(appId: string): Promise<void> {
    const out = await this.device.shell([
      'monkey',
      '-p',
      assertPackage(appId),
      '-c',
      'android.intent.category.LAUNCHER',
      '1',
    ])
    if (/No activities found|monkey aborted/i.test(out)) {
      throw new AdbError(`cannot launch ${appId}: ${out.trim()}`)
    }
  }

  async openDeepLink(url: string): Promise<void> {
    const out = await this.device.shell([
      'am',
      'start',
      '-W',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      url,
      '-p',
      this.app(),
    ])
    if (/Error:/.test(out)) throw new AdbError(`cannot open ${url}: ${out.trim()}`)
  }

  async isAppRunning(appId: string): Promise<boolean> {
    try {
      return (await this.device.shell(['pidof', assertPackage(appId)])).trim().length > 0
    } catch {
      // pidof exits 1 when no process matches.
      return false
    }
  }

  async deviceLogs(sinceMs: number): Promise<string> {
    return this.device.shell([
      'logcat',
      '-d',
      '-b',
      'main,system,crash',
      '-v',
      'threadtime',
      '-T',
      (Math.max(0, sinceMs) / 1000).toFixed(3),
    ])
  }

  /**
   * Package of the crash / ANR dialog that has the focus: the system names its window
   * "Application Not Responding: <package>" or "Application Error: <package>" (`dumpsys window`).
   */
  async systemDialogOwner(): Promise<string | undefined> {
    const out = await this.device.shell(['dumpsys', 'window', 'windows'])
    const focus = out.split('\n').filter((line) => /mCurrentFocus|mFocusedWindow/.test(line))
    for (const line of [...focus, out]) {
      const owner = SYSTEM_DIALOG_TITLE.exec(line)?.[1]
      if (owner) return owner
    }
    return undefined
  }

  /** The resumed activity (`dumpsys activity activities`), for screen fingerprints (D24). */
  async foregroundActivity(): Promise<ForegroundActivity | undefined> {
    return parseResumedActivity(await this.device.shell(['dumpsys', 'activity', 'activities']))
  }

  /** A crash of the app under test was logged since `sinceMs` (`logcat -b crash`). */
  async crashedSince(sinceMs: number): Promise<boolean> {
    const out = await this.device.shell([
      'logcat',
      '-d',
      '-b',
      'crash',
      '-T',
      (Math.max(0, sinceMs) / 1000).toFixed(3),
    ])
    return out.includes(`Process: ${this.app()}`)
  }
}

const RESUMED =
  /\b(?:topResumedActivity|mResumedActivity|ResumedActivity)\s*[=:]\s*ActivityRecord\{\S+ u\d+ ([A-Za-z][\w.]*)\/([\w.$]+)/

/**
 * The resumed activity from `dumpsys activity activities` (Android 10+: `topResumedActivity=` or
 * `ResumedActivity:`; older: `mResumedActivity:`). The activity is relative to its package when
 * it lives inside it, as dumpsys usually prints it, so both spellings give one fingerprint.
 */
export function parseResumedActivity(dumpsys: string): ForegroundActivity | undefined {
  const match = RESUMED.exec(dumpsys)
  if (!match) return undefined
  const pkg = match[1] ?? ''
  const activity = match[2] ?? ''
  return {
    package: pkg,
    activity: activity.startsWith(`${pkg}.`) ? activity.slice(pkg.length) : activity,
  }
}
