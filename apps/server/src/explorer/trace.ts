import { createHash } from 'node:crypto'
import {
  walkTree,
  type ActionDecision,
  type ElementNode,
  type Step,
  type TransitionAction,
} from '@coral/shared'
import { labelOf } from '../ai/screen'
import type { SeenTransition } from './appmap'

/** What a step row holds that the trace helpers read (`exploration_steps`). */
export interface TraceRow {
  n: number
  segment: number
  fingerprint: string
  status: string
  step: unknown
}

/**
 * Everything a person sees on the screen, text included (unlike the runner's `structureHash`): an
 * action after which this is unchanged did nothing at all (frontier "dead", FR-024).
 */
export function contentHash(tree: readonly ElementNode[]): string {
  const hash = createHash('sha1')
  for (const node of walkTree(tree)) {
    const { x, y, w, h } = node.bounds
    hash.update(
      `${node.ref}|${node.class}|${node.platform_id}|${node.text}|${node.desc}|${x},${y},${w},${h}|${
        node.android?.focused === true ? 'f' : ''
      }\n`,
    )
  }
  return hash.digest('hex')
}

/** The step a transition keeps: no id, expectation, snapshot, nor image (those live with test cases). */
export function transitionAction(step: Step): TransitionAction {
  const action: Record<string, unknown> = { ...step }
  delete action.id
  delete action.expect
  delete action.snapshot
  if ('target' in step && step.target) {
    const target = step.target.filter((l) => l.image === undefined)
    if (target.length > 0) action.target = target
  }
  return action as TransitionAction
}

/**
 * Transitions of a trace (research R11): a done step with a recorded action, followed in the same
 * segment by a step on another screen. Popups, refusals and restarts move nowhere on their own.
 */
export function transitionsOf(rows: readonly TraceRow[]): SeenTransition[] {
  const sorted = [...rows].sort((a, b) => a.n - b.n)
  const out: SeenTransition[] = []
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const row = sorted[i]
    const next = sorted[i + 1]
    if (!row || !next || row.status !== 'done' || row.step === null) continue
    if (next.segment !== row.segment || next.fingerprint === row.fingerprint) continue
    out.push({
      from: row.fingerprint,
      to: next.fingerprint,
      action: transitionAction(row.step as Step),
    })
  }
  return out
}

/** Distinct transitions of a trace, as the app map counts them: (from, to, first locator). */
export function countTransitions(transitions: readonly SeenTransition[]): number {
  return new Set(
    transitions.map((t) => {
      const target = (t.action as { target?: readonly unknown[] }).target
      return JSON.stringify([t.from, t.to, target?.[0] ?? t.action.action])
    }),
  ).size
}

/** `tap "View menu" (#1)`: an action as the trace, the history sent to the AI and the web show it. */
export function actionSummary(
  decision: ActionDecision | null,
  element?: ElementNode,
  system?: 'back' | 'restart_app',
): string {
  if (!decision) return system === 'restart_app' ? 'restart the app' : 'back (system)'
  const label = element ? labelOf(element) : ''
  const on = decision.action !== 'done' && 'element' in decision ? ` (#${decision.element})` : ''
  const named = label ? ` ${JSON.stringify(label.slice(0, 60))}` : ''
  switch (decision.action) {
    case 'tap':
    case 'long_press':
      return `${decision.action}${named}${on}`
    case 'type': {
      const value =
        decision.secret !== undefined
          ? `secret ${decision.secret}`
          : decision.test_data !== undefined
            ? `test_data ${decision.test_data}`
            : JSON.stringify(decision.text ?? '')
      return `type ${value} into${named || ' field'}${on}`
    }
    case 'swipe':
      return `swipe ${decision.direction}${named}${on}`
    case 'tap_point':
      return `tap at ${decision.point_pct.map((v) => `${Math.round(v * 100)}%`).join(', ')}`
    case 'done':
      return decision.goal_reached ? 'goal reached' : 'goal not reachable'
    default:
      return decision.action.replace('_', ' ')
  }
}
