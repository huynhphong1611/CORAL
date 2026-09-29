import {
  DEFAULT_POPUPS_YAML,
  parseYaml,
  popupsSchema,
  stepSchema,
  type Popups,
} from '@coral/shared'
import { describe, expect, it } from 'vitest'
import { APP, androidTree } from '../testing/android-fixtures'
import type { Point } from './driver'
import { createPopupGuard, findPopups } from './popup-guard'
import type { PopupContext, PopupReason } from './run-testcase'

const popups: Popups = popupsSchema.parse(parseYaml(DEFAULT_POPUPS_YAML).value)

function setup(rules: Popups = popups, dialogOwner?: string) {
  const taps: Point[] = []
  const guard = createPopupGuard({
    popups: rules,
    driver: {
      tapAt: (p) => Promise.resolve(void taps.push(p)),
      ...(dialogOwner ? { systemDialogOwner: () => Promise.resolve(dialogOwner) } : {}),
    },
  })
  const ctx = (
    reason: PopupReason = 'target_not_found',
    step?: object,
    limitReached = false,
  ): PopupContext => ({
    appId: APP,
    reason,
    limitReached,
    resolveCtx: { platform: 'android', screen: { width: 1080, height: 2400 }, appId: APP },
    ...(step ? { step: stepSchema.parse({ id: 's1', ...step }) } : {}),
  })
  return { guard, taps, ctx }
}

describe('findPopups', () => {
  it('finds foreign windows and dialog panels, not the keyboard, status bar or plain screens', () => {
    expect(findPopups(androidTree('login'), APP)).toEqual([])
    expect(findPopups(androidTree('keyboard-open'), APP)).toEqual([])
    expect(findPopups(androidTree('permission-dialog'), APP)[0]?.root.package_or_bundle).toBe(
      'com.google.android.permissioncontroller',
    )
    expect(findPopups(androidTree('rate-app-dialog'), APP)[0]?.root.platform_id).toBe(
      'android:id/parentPanel',
    )
  })
})

describe('popup guard', () => {
  it('allows the runtime permission dialog (rule android_permission)', async () => {
    const { guard, taps, ctx } = setup()
    expect(await guard.handle(androidTree('permission-dialog'), ctx())).toEqual({
      rule: 'android_permission',
      button: 'While using the app',
    })
    expect(taps).toEqual([{ x: 540, y: 1260 }])
  })

  it('dismisses the in-app rating dialog with "Để sau"', async () => {
    const { guard, taps, ctx } = setup()
    expect(await guard.handle(androidTree('rate-app-dialog'), ctx('expect_failed'))).toEqual({
      rule: 'rate_app',
      button: 'Để sau',
    })
    expect(taps).toEqual([{ x: 540, y: 1425 }])
  })

  it('blocks a stuck step on a dialog whose only buttons are never_tap', async () => {
    const { guard, taps, ctx } = setup()
    await expect(guard.handle(androidTree('never-tap-only-dialog'), ctx())).rejects.toMatchObject({
      code: 'BLOCKED_BY_POPUP',
      message: expect.stringContaining('Xác nhận đơn hàng') as unknown,
    })
    // After launch the same popup is left for the next steps.
    expect(await guard.handle(androidTree('never-tap-only-dialog'), ctx('launch'))).toBeNull()
    expect(taps).toEqual([])
  })

  it('never taps never_tap even when a rule lists the button', async () => {
    const rules: Popups = {
      ...popups,
      rules: [{ name: 'buy', match: { text_contains: 'đơn hàng' }, tap_any: ['Mua'] }],
    }
    const { guard, taps, ctx } = setup(rules)
    await expect(guard.handle(androidTree('never-tap-only-dialog'), ctx())).rejects.toMatchObject({
      code: 'BLOCKED_BY_POPUP',
      message: expect.stringContaining('rule buy') as unknown,
    })
    expect(taps).toEqual([])
  })

  it('reports crash and ANR dialogs instead of closing them', async () => {
    const { guard, taps, ctx } = setup()
    await expect(guard.handle(androidTree('crash-dialog'), ctx('launch'))).rejects.toMatchObject({
      code: 'APP_CRASHED',
      message: 'My Demo App keeps stopping',
    })
    await expect(guard.handle(androidTree('anr-dialog'), ctx())).rejects.toMatchObject({
      code: 'APP_NOT_RESPONDING',
    })
    // The driver names the app under test as the owner: still a failure of the app.
    const own = setup(popups, APP)
    await expect(own.guard.handle(androidTree('anr-dialog'), own.ctx())).rejects.toMatchObject({
      code: 'APP_NOT_RESPONDING',
    })
    expect([...taps, ...own.taps]).toEqual([])
  })

  it("lets another app's crash or ANR dialog go (launcher after an emulator boot)", async () => {
    const launcher = 'com.google.android.apps.nexuslauncher'
    const { guard, taps, ctx } = setup(popups, launcher)
    // Close app, not Wait: on the CI emulator Wait brought the launcher's ANR back every few seconds.
    expect(await guard.handle(androidTree('anr-dialog'), ctx('launch'))).toEqual({
      rule: 'system_anr',
      button: 'Close app',
    })
    expect(await guard.handle(androidTree('crash-dialog'), ctx())).toEqual({
      rule: 'system_crash',
      button: 'Close app',
    })
    // Centre of Close app [120,1150][960,1260] in anr-dialog.xml.
    expect(taps[0]).toEqual({ x: 540, y: 1205 })
    expect(taps).toHaveLength(2)
    await expect(
      guard.handle(androidTree('anr-dialog'), ctx('target_not_found', undefined, true)),
    ).rejects.toMatchObject({ code: 'BLOCKED_BY_POPUP' })
    const strict = setup({ ...popups, never_tap: [...popups.never_tap, 'close app'] }, launcher)
    await expect(
      strict.guard.handle(androidTree('anr-dialog'), strict.ctx()),
    ).rejects.toMatchObject({ code: 'BLOCKED_BY_POPUP' })
    expect(strict.taps).toEqual([])
  })

  it('leaves the popup alone when the step is testing it', async () => {
    const { guard, taps, ctx } = setup()
    const tapDeny = { action: 'tap', target: [{ text: 'Don’t allow' }] }
    expect(
      await guard.handle(androidTree('permission-dialog'), ctx('target_covered', tapDeny)),
    ).toBeNull()
    const expectDialog = { action: 'assert', expect: { visible_text: 'take pictures' } }
    expect(
      await guard.handle(androidTree('permission-dialog'), ctx('expect_failed', expectDialog)),
    ).toBeNull()
    expect(taps).toEqual([])

    // Same text rule as expect (case-sensitive): this step is not about the dialog.
    const otherCase = { action: 'assert', expect: { visible_text: 'TAKE PICTURES' } }
    expect(
      await guard.handle(androidTree('permission-dialog'), ctx('expect_failed', otherCase)),
    ).toMatchObject({ rule: 'android_permission' })
    expect(taps).toHaveLength(1)
  })

  it('refuses a further popup once the per-step limit is reached (D25)', async () => {
    const { guard, taps, ctx } = setup()
    await expect(
      guard.handle(androidTree('permission-dialog'), ctx('target_not_found', undefined, true)),
    ).rejects.toMatchObject({
      code: 'BLOCKED_BY_POPUP',
    })
    expect(taps).toEqual([])
  })

  it('does nothing without a popup', async () => {
    const { guard, taps, ctx } = setup()
    expect(await guard.handle(androidTree('overlay-bottom-sheet'), ctx())).toBeNull()
    expect(taps).toEqual([])
  })
})
