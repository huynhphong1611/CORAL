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
import type { UiDriver } from './driver'
import { StepFailure } from './errors'
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

/** Crash and ANR dialogs end the step; the guard never dismisses them (R6). */
function appFailure(tree: readonly ElementNode[]): StepFailure | undefined {
  const nodes = [...walkTree(tree)].filter((n) => n.visible)
  const title = nodes.find((n) => n.platform_id === 'android:id/alertTitle')?.text ?? ''
  if (nodes.some((n) => n.platform_id === ANR_BUTTON)) {
    return new StepFailure('APP_NOT_RESPONDING', title || 'application not responding')
  }
  if (nodes.some((n) => CRASH_BUTTONS.includes(n.platform_id))) {
    return new StepFailure('APP_CRASHED', title || 'application crashed')
  }
  return undefined
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
      const needle = normalizeButtonText(condition.visible_text)
      if (popup.nodes.some((n) => normalizeButtonText(n.text).includes(needle))) return true
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
 * presses a never_tap button, never closes crash/ANR dialogs, and leaves a popup alone when the
 * current step is about it. Unknown popups block the step only when the step is stuck.
 */
export function createPopupGuard(options: {
  popups: Popups
  driver: Pick<UiDriver, 'tapAt'>
}): PopupGuard {
  return {
    async handle(tree: ElementNode[], ctx: PopupContext): Promise<HandledPopup | null> {
      const failure = appFailure(tree)
      if (failure) throw failure

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
