import {
  decidePopup,
  locatorPlatforms,
  normalizeButtonText,
  walkTree,
  type ElementNode,
  type ExpectCondition,
  type Locator,
  type Popups,
  type Step,
} from '@coral/shared'
import type { TargetLifecycle, UiDriver } from './driver'
import { StepFailure } from './errors'
import { conditionFailure } from './expect'
import { center } from './locator/geometry'
import { findAll, type ResolveContext } from './locator/resolve'
import type { HandledPopup, PopupContext, PopupGuard } from './run-testcase'

/** System UI that is on screen all the time and never blocks the app. */
const SYSTEM_UI = 'com.android.systemui'
const DIALOG_PANEL = 'android:id/parentPanel'
const CRASH_BUTTONS = [
  'android:id/aerr_close',
  'android:id/aerr_restart',
  'android:id/aerr_app_info',
]
const ANR_BUTTON = 'android:id/aerr_wait'

export interface Popup {
  /** Window or dialog panel that is the popup. */
  root: ElementNode
  nodes: ElementNode[]
}

const isKeyboard = (window: ElementNode) => /inputmethod|keyboard/i.test(window.package_or_bundle)

/** Something the user could press: toasts and snackbars have nothing, so they are ignored. */
const actionable = (nodes: readonly ElementNode[]) =>
  nodes.some((n) => n.visible && (n.clickable || /Button$/.test(n.class)))

/**
 * Popups on screen (research R6): windows of another package than the app (not the status bar
 * or the keyboard), and dialog panels (`android:id/parentPanel`) inside the app's own windows.
 * Topmost first.
 */
export function findPopups(tree: readonly ElementNode[], appId: string): Popup[] {
  const popups: Popup[] = []
  for (const window of [...tree].reverse()) {
    if (!window.visible || window.package_or_bundle === SYSTEM_UI || isKeyboard(window)) continue
    const nodes = [...walkTree([window])]
    if (window.package_or_bundle !== appId) {
      if (actionable(nodes)) popups.push({ root: window, nodes })
      continue
    }
    for (const panel of nodes.filter((n) => n.platform_id === DIALOG_PANEL && n.visible)) {
      const inner = [...walkTree([panel])]
      if (actionable(inner)) popups.push({ root: panel, nodes: inner })
    }
  }
  return popups
}

interface SystemDialog {
  kind: 'anr' | 'crash'
  title: string
  /** Button that lets another app's dialog go without harming anything: Wait / Close app. */
  dismiss: ElementNode | undefined
}

/** The system's crash or not-responding dialog, if one is on screen (R6). */
function systemDialog(tree: readonly ElementNode[]): SystemDialog | undefined {
  const nodes = [...walkTree(tree)].filter((n) => n.visible)
  const title = nodes.find((n) => n.platform_id === 'android:id/alertTitle')?.text ?? ''
  const wait = nodes.find((n) => n.platform_id === ANR_BUTTON)
  const close = nodes.find((n) => n.platform_id === CRASH_BUTTONS[0])
  if (wait) return { kind: 'anr', title, dismiss: wait }
  if (nodes.some((n) => CRASH_BUTTONS.includes(n.platform_id))) {
    return { kind: 'crash', title, dismiss: close }
  }
  return undefined
}

function appFailure(dialog: SystemDialog): StepFailure {
  return dialog.kind === 'anr'
    ? new StepFailure('APP_NOT_RESPONDING', dialog.title || 'application not responding')
    : new StepFailure('APP_CRASHED', dialog.title || 'application crashed')
}

function conditionsOf(step: Step): ExpectCondition[] {
  return [...(step.expect ?? []), ...(step.action === 'wait' ? (step.until ?? []) : [])]
}

/**
 * The step is testing the popup itself (§9.2 exception): the first applicable locator of its
 * target or of an expect `visible`, or a `visible_text`, points inside the popup.
 */
function stepTargetsPopup(step: Step | undefined, popup: Popup, ctx: ResolveContext): boolean {
  if (!step) return false
  const inside = new Set(popup.nodes.map((n) => n.ref))
  const firstApplicable = (chain: readonly Locator[]) =>
    chain.find((l) => locatorPlatforms(l).includes(ctx.platform))
  const hits = (locator: Locator | undefined) =>
    locator !== undefined && findAll(locator, [popup.root], ctx).some((n) => inside.has(n.ref))

  if ('target' in step && step.target && hits(firstApplicable(step.target))) return true
  for (const condition of conditionsOf(step)) {
    if (condition.visible !== undefined) {
      const chain = Array.isArray(condition.visible) ? condition.visible : [condition.visible]
      if (hits(firstApplicable(chain))) return true
    }
    if (condition.visible_text !== undefined) {
      const text = { visible_text: condition.visible_text }
      if (conditionFailure(text, [popup.root], ctx) === undefined) return true
    }
  }
  return false
}

const describe = (popup: Popup) =>
  popup.nodes
    .map((n) => n.text)
    .filter(Boolean)
    .slice(0, 3)
    .join(' / ')

/**
 * Popup guard layer 2 (SPEC §9.2, §9.4, D25): dismisses popups by the project's rules, never
 * presses a never_tap button, and leaves a popup alone when the current step is about it. A crash
 * or ANR dialog of the app under test ends the step (never dismissed); the same dialog of another
 * app (e.g. the launcher right after an emulator boots) is let go with Wait / Close app — only when
 * the driver can tell whose dialog it is. Unknown popups block the step only when it is stuck.
 */
export function createPopupGuard(options: {
  popups: Popups
  driver: Pick<UiDriver, 'tapAt'> & Pick<TargetLifecycle, 'systemDialogOwner'>
}): PopupGuard {
  const forbidden = new Set(options.popups.never_tap.map(normalizeButtonText))
  return {
    async handle(tree: ElementNode[], ctx: PopupContext): Promise<HandledPopup | null> {
      const dialog = systemDialog(tree)
      if (dialog) {
        const owner = await options.driver.systemDialogOwner?.().catch(() => undefined)
        if (!owner || owner === ctx.appId) throw appFailure(dialog)
        const button = dialog.dismiss
        if (!button || forbidden.has(normalizeButtonText(button.text))) {
          throw new StepFailure('BLOCKED_BY_POPUP', `dialog of ${owner}: "${dialog.title}"`)
        }
        if (ctx.limitReached) {
          throw new StepFailure(
            'BLOCKED_BY_POPUP',
            `more popups than the limit per step (last: dialog of ${owner})`,
          )
        }
        await options.driver.tapAt(center(button.bounds))
        return { rule: dialog.kind === 'anr' ? 'system_anr' : 'system_crash', button: button.text }
      }

      for (const popup of findPopups(tree, ctx.appId)) {
        if (stepTargetsPopup(ctx.step, popup, ctx.resolveCtx)) return null
        const decision = decidePopup(options.popups, popup.nodes)
        if (decision.kind === 'tap') {
          if (ctx.limitReached) {
            throw new StepFailure(
              'BLOCKED_BY_POPUP',
              `more popups than the limit per step (last: ${decision.rule})`,
            )
          }
          await options.driver.tapAt(center(decision.node.bounds))
          return { rule: decision.rule, button: decision.button }
        }
        // After launch an unknown popup may be what the next steps handle: leave it.
        if (ctx.reason === 'launch') return null
        throw new StepFailure(
          'BLOCKED_BY_POPUP',
          decision.kind === 'blocked'
            ? `popup "${describe(popup)}" (rule ${decision.rule}): ${decision.reason}`
            : `popup "${describe(popup)}" matches no rule in popups.yaml`,
        )
      }
      return null
    },
  }
}
