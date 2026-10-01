import { describe, expect, it } from 'vitest'
import { Adb, type ExecFn } from './adb'
import {
  AndroidLifecycle,
  MemoryInstallRegistry,
  STOP_POLL_MS,
  STOP_POLLS,
  parseResumedActivity,
} from './lifecycle'

const APP = 'com.saucelabs.mydemoapp.android'

function setup(
  opts: {
    emulator?: boolean
    apiLevel?: number
    replies?: Record<string, string | (() => string)>
    fail?: string[]
  } = {},
) {
  const calls: string[] = []
  const slept: number[] = []
  const exec: ExecFn = (_file, args) => {
    const key = args.slice(2).join(' ')
    calls.push(key)
    if (opts.fail?.some((f) => key.startsWith(f))) return Promise.reject(new Error('exit 1'))
    const reply =
      Object.entries(opts.replies ?? {}).find(([prefix]) => key.startsWith(prefix))?.[1] ??
      (key.includes('pm clear') || key.startsWith('install') ? 'Success\n' : '')
    return Promise.resolve(Buffer.from(typeof reply === 'function' ? reply() : reply))
  }
  const registry = new MemoryInstallRegistry()
  const lifecycle = new AndroidLifecycle(new Adb('adb', exec).device('emu-1'), {
    appId: APP,
    apiLevel: opts.apiLevel ?? 34,
    emulator: opts.emulator ?? true,
    registry,
    clock: { now: () => 0, sleep: (ms) => (slept.push(ms), Promise.resolve()) },
  })
  return { lifecycle, calls, registry, slept }
}

/** `dumpsys activity activities` while an activity of `pkg` is still there. */
const ACTIVITIES = (pkg: string) =>
  `  * Hist  #0: ActivityRecord{e51d8fa u0 ${pkg}/.view.activities.MainActivity t17 f}\n`

describe('AndroidLifecycle', () => {
  it('installs with -r -d (never -g) and skips an unchanged build', async () => {
    const { lifecycle, calls } = setup()
    await lifecycle.install('/b/app.apk', 'sha-1')
    await lifecycle.install('/b/app.apk', 'sha-1')
    await lifecycle.install('/b/app.apk', 'sha-2')
    expect(calls).toEqual(['install -r -d /b/app.apk', 'install -r -d /b/app.apk'])
  })

  it('clears data and grants mapped permissions for the app under test only (P6)', async () => {
    const { lifecycle, calls } = setup({ apiLevel: 32 })
    await lifecycle.resetApp(APP)
    await lifecycle.grantPermissions(APP, ['camera', 'notifications', 'location'])
    expect(calls).toEqual([
      `shell am force-stop ${APP}`,
      'shell dumpsys activity activities',
      `shell pm clear ${APP}`,
      `shell pm grant ${APP} android.permission.CAMERA`,
      // notifications is not a runtime permission before API 33.
      `shell pm grant ${APP} android.permission.ACCESS_FINE_LOCATION`,
      `shell pm grant ${APP} android.permission.ACCESS_COARSE_LOCATION`,
    ])
    await expect(lifecycle.resetApp('com.x; reboot')).rejects.toThrow('invalid Android package')
  })

  it('clears data only once the stopped app has no activity left (launch race)', async () => {
    let polls = 0
    const { lifecycle, calls, slept } = setup({
      replies: {
        'shell dumpsys activity activities': () =>
          // Two polls still list the app; another package with the same prefix never counts.
          (polls++ < 2 ? ACTIVITIES(APP) : '') + ACTIVITIES(`${APP}.other`),
      },
    })
    await lifecycle.resetApp(APP)
    expect(calls).toEqual([
      `shell am force-stop ${APP}`,
      ...Array<string>(3).fill('shell dumpsys activity activities'),
      `shell pm clear ${APP}`,
    ])
    expect(slept).toEqual([STOP_POLL_MS, STOP_POLL_MS])

    // An activity that never goes away delays the reset by 5 s at most.
    const stuck = setup({ replies: { 'shell dumpsys activity activities': ACTIVITIES(APP) } })
    await stuck.lifecycle.resetApp(APP)
    expect(stuck.slept).toHaveLength(STOP_POLLS)
    expect(stuck.calls.at(-1)).toBe(`shell pm clear ${APP}`)
  })

  it('disables animations and restores them only on real devices', async () => {
    const replies = {
      'shell settings get global window_animation_scale': '1.0\n',
      'shell settings get global transition_animation_scale': '0.5\n',
      'shell settings get global animator_duration_scale': 'null\n',
    }
    const real = setup({ emulator: false, replies })
    await real.lifecycle.disableAnimations()
    await real.lifecycle.restoreAnimations()
    expect(real.calls.filter((c) => c.includes('put') || c.includes('delete'))).toEqual([
      'shell settings put global window_animation_scale 0',
      'shell settings put global transition_animation_scale 0',
      'shell settings put global animator_duration_scale 0',
      'shell settings put global window_animation_scale 1.0',
      'shell settings put global transition_animation_scale 0.5',
      'shell settings delete global animator_duration_scale',
    ])
    const emu = setup({ emulator: true, replies })
    await emu.lifecycle.disableAnimations()
    await emu.lifecycle.restoreAnimations()
    expect(emu.calls.filter((c) => c.includes('put'))).toHaveLength(3)
  })

  it('launches with monkey and opens deep links safely quoted', async () => {
    const { lifecycle, calls } = setup()
    await lifecycle.launch(APP)
    await lifecycle.openDeepLink('mydemoapprn://product-details/1?x=1&y=2')
    expect(calls).toEqual([
      `shell monkey -p ${APP} -c android.intent.category.LAUNCHER 1`,
      `shell am start -W -a android.intent.action.VIEW -d 'mydemoapprn://product-details/1?x=1&y=2' -p ${APP}`,
    ])
    const broken = setup({
      replies: { 'shell monkey': '** No activities found to run, monkey aborted.' },
    })
    await expect(broken.lifecycle.launch(APP)).rejects.toThrow('cannot launch')
  })

  it('checks the process, logs and crashes since a moment', async () => {
    const { lifecycle, calls } = setup({
      replies: {
        'shell pidof': '4242\n',
        'shell logcat -d -b crash': `--------- beginning of crash\nFATAL EXCEPTION: main\nProcess: ${APP}, PID: 4242\n`,
      },
    })
    expect(await lifecycle.isAppRunning(APP)).toBe(true)
    expect(await lifecycle.crashedSince(1_700_000_000_123)).toBe(true)
    await lifecycle.deviceLogs(1_700_000_000_123)
    expect(calls.at(-1)).toBe(
      'shell logcat -d -b main,system,crash -v threadtime -T 1700000000.123',
    )
    expect(await setup({ fail: ['shell pidof'] }).lifecycle.isAppRunning(APP)).toBe(false)
  })

  it('reads whose crash / ANR dialog has the focus from dumpsys window', async () => {
    const dump = (focus: string) => ({
      'shell dumpsys window windows': [
        'WINDOW MANAGER WINDOWS (dumpsys window windows)',
        `  Window #3 Window{a1 u0 ${APP}/.MainActivity}:`,
        `  mCurrentFocus=Window{b2 u0 ${focus}}`,
        `  mFocusedApp=ActivityRecord{c3 u0 ${APP}/.MainActivity t12}`,
      ].join('\n'),
    })
    const launcher = setup({
      replies: dump('Application Not Responding: com.google.android.apps.nexuslauncher'),
    })
    expect(await launcher.lifecycle.systemDialogOwner()).toBe(
      'com.google.android.apps.nexuslauncher',
    )
    expect(launcher.calls).toEqual(['shell dumpsys window windows'])
    const crash = setup({ replies: dump(`Application Error: ${APP}`) })
    expect(await crash.lifecycle.systemDialogOwner()).toBe(APP)
    const none = setup({ replies: dump(`${APP}/.MainActivity`) })
    expect(await none.lifecycle.systemDialogOwner()).toBeUndefined()
  })

  it('reads the foreground activity from dumpsys activity (Android 14 and older)', async () => {
    // Excerpt of `dumpsys activity activities` on an Android 14 emulator.
    const android14 = [
      'ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)',
      'Display #0 (activities from top to bottom):',
      '  * Task{8c1e2d0 #17 type=standard A=10190:com.saucelabs.mydemoapp.android}',
      `      * Hist  #0: ActivityRecord{e51d8fa u0 ${APP}/.view.activities.MainActivity t17}`,
      `    topResumedActivity=ActivityRecord{e51d8fa u0 ${APP}/.view.activities.MainActivity t17}`,
      `  ResumedActivity: ActivityRecord{e51d8fa u0 ${APP}/.view.activities.MainActivity t17}`,
    ].join('\n')
    const { lifecycle, calls } = setup({
      replies: { 'shell dumpsys activity activities': android14 },
    })
    expect(await lifecycle.foregroundActivity()).toEqual({
      package: APP,
      activity: '.view.activities.MainActivity',
    })
    expect(calls).toEqual(['shell dumpsys activity activities'])
    // Android 9 spelling, and a class name written in full inside its package.
    expect(
      parseResumedActivity(
        `  mResumedActivity: ActivityRecord{1 u0 ${APP}/${APP}.view.activities.SplashActivity t3}`,
      ),
    ).toEqual({ package: APP, activity: '.view.activities.SplashActivity' })
    expect(
      parseResumedActivity(
        '  ResumedActivity: ActivityRecord{2 u0 com.google.android.permissioncontroller/com.android.permissioncontroller.permission.ui.GrantPermissionsActivity t9}',
      ),
    ).toEqual({
      package: 'com.google.android.permissioncontroller',
      activity: 'com.android.permissioncontroller.permission.ui.GrantPermissionsActivity',
    })
    expect(parseResumedActivity('nothing resumed')).toBeUndefined()
  })

  it('binds the app later for a device session and keeps one install registry', async () => {
    const calls: string[] = []
    const exec: ExecFn = (_file, args) => {
      calls.push(args.slice(2).join(' '))
      return Promise.resolve(Buffer.from('Success\n'))
    }
    const registry = new MemoryInstallRegistry()
    const session = new AndroidLifecycle(new Adb('adb', exec).device('emu-1'), {
      apiLevel: 34,
      emulator: true,
      registry,
    })
    // Nothing app-specific works without an app…
    await expect(session.install('/b/app.apk', 'sha-1')).rejects.toThrow('no app under test')
    await expect(session.openDeepLink('mydemo://x')).rejects.toThrow('no app under test')
    // …device-level commands and forApp() do.
    await session.launch(APP)
    const app = session.forApp(APP)
    await app.install('/b/app.apk', 'sha-1')
    await session.forApp(APP).install('/b/app.apk', 'sha-1')
    expect(calls.filter((c) => c.startsWith('install'))).toHaveLength(1)
    expect(registry.get('emu-1', APP)).toBe('sha-1')
    expect(() => session.forApp('not a package')).toThrow()
  })
})
