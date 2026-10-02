import { touchTargetAt } from '@coral/runner'
import {
  normalizeButtonText,
  walkTree,
  type ActionDecision,
  type ElementNode,
  type api,
} from '@coral/shared'
import {
  isField,
  isSearchField,
  labelOf,
  type ListedElement,
  type SerializedScreen,
} from '../ai/screen'

const SECRET_REF = /^\$\{secret:([A-Za-z_][A-Za-z0-9_]*)\}$/

export interface SafetyContext {
  screen: SerializedScreen
  tree: readonly ElementNode[]
  /** never_tap of popups.yaml and of the skills (SPEC §9.4). */
  neverTap: readonly string[]
  /** Named test data of the skills (`${secret:NAME}` values stay references). */
  testData: Readonly<Record<string, string>>
  /** Secrets the goal names (`${secret:NAME}`): a person's prompt or imported case uses them. */
  goalSecrets?: ReadonlySet<string>
  /** Secret values the server knows, name → value: made-up text may not equal one. */
  secrets: Readonly<Record<string, string>>
  /** Screens where submitting made-up data is allowed (rules.yaml `allow_submit`). */
  allowSubmit: readonly { screen_text: string }[]
  /** Fields of this screen that received made-up text (not search boxes), by element key. */
  inventedFields: ReadonlySet<string>
}

export type SafetyVerdict =
  | {
      ok: true
      element?: ListedElement
      /** Device pixels of a `tap_point`. */
      point?: { x: number; y: number }
      flags: api.StepFlag[]
    }
  | { ok: false; refusal: api.StepRefusal; message: string }

const refuse = (refusal: api.StepRefusal, message: string): SafetyVerdict => ({
  ok: false,
  refusal,
  message,
})

/** The secret names the skills let the AI type (`test_data` values `${secret:NAME}`). */
function allowedSecrets(testData: Readonly<Record<string, string>>): Set<string> {
  const names = new Set<string>()
  for (const value of Object.values(testData)) {
    const name = SECRET_REF.exec(value)?.[1]
    if (name) names.add(name)
  }
  return names
}

function screenAllowsSubmit(ctx: SafetyContext): boolean {
  if (ctx.allowSubmit.length === 0) return false
  const texts = [...walkTree(ctx.tree)].filter((n) => n.visible).map((n) => n.text)
  return ctx.allowSubmit.some((rule) => texts.some((t) => t.includes(rule.screen_text)))
}

/**
 * The safety checks of the Explorer (research R10, FR-022, FR-022a, P6): run after the AI on the
 * screen's own element list — never on what the AI wrote — so text on the screen or in a tool
 * result cannot talk the Explorer into a forbidden action. Back is always allowed.
 */
export function checkDecision(decision: ActionDecision, ctx: SafetyContext): SafetyVerdict {
  const neverTap = new Set(ctx.neverTap.map(normalizeButtonText))
  switch (decision.action) {
    case 'back':
    case 'hide_keyboard':
    case 'restart_app':
    case 'done':
      return { ok: true, flags: [] }

    case 'tap_point': {
      if (ctx.screen.elements.length > 0) {
        return refuse('point_pct_not_allowed', 'tap_point only when no element can be used (P2)')
      }
      const [px, py] = decision.point_pct
      const point = {
        x: Math.round(px * ctx.screen.input.width),
        y: Math.round(py * ctx.screen.input.height),
      }
      const target = touchTargetAt(ctx.tree, point)
      if (target && neverTap.has(normalizeButtonText(labelOf(target)))) {
        return refuse('never_tap', `"${labelOf(target)}" is in never_tap`)
      }
      return { ok: true, point, flags: [] }
    }

    case 'tap':
    case 'long_press':
    case 'swipe':
    case 'type': {
      const element = ctx.screen.elements.find((e) => e.n === decision.element)
      if (!element) {
        return refuse('not_found', `element #${decision.element} is not in the list of this screen`)
      }
      const label = labelOf(element.node)
      if (label && neverTap.has(normalizeButtonText(label))) {
        return refuse('never_tap', `"${label}" is in never_tap`)
      }
      if (decision.action === 'type') return checkTyping(decision, element, ctx)
      if (decision.action === 'swipe') return { ok: true, element, flags: [] }
      // A tap after made-up text went into a form would submit it (FR-022a).
      if (ctx.inventedFields.size > 0 && !isField(element.node) && !screenAllowsSubmit(ctx)) {
        return refuse(
          'invented_submit',
          'made-up text was typed on this screen: use test data or a secret to submit the form',
        )
      }
      return { ok: true, element, flags: [] }
    }
  }
}

function checkTyping(
  decision: Extract<ActionDecision, { action: 'type' }>,
  element: ListedElement,
  ctx: SafetyContext,
): SafetyVerdict {
  if (!isField(element.node)) {
    return refuse('not_actionable', `element #${element.n} is not a field`)
  }
  if (decision.secret !== undefined) {
    if (
      !allowedSecrets(ctx.testData).has(decision.secret) &&
      !ctx.goalSecrets?.has(decision.secret)
    ) {
      return refuse(
        'invalid_text',
        `secret ${decision.secret} is not in the test data of the skills nor in the goal`,
      )
    }
    if (ctx.secrets[decision.secret] === undefined) {
      return refuse('invalid_text', `secret ${decision.secret} has no value on this server`)
    }
    return { ok: true, element, flags: [] }
  }
  if (decision.test_data !== undefined) {
    if (ctx.testData[decision.test_data] === undefined) {
      return refuse('invalid_text', `test_data ${decision.test_data} is not in the skills`)
    }
    return { ok: true, element, flags: [] }
  }
  const text = decision.text ?? ''
  const leaks = Object.values(ctx.secrets).some(
    (value) => value.length >= 4 && text.includes(value),
  )
  if (leaks) return refuse('invalid_text', 'made-up text may not contain a secret value')
  return {
    ok: true,
    element,
    flags: isSearchField(element.node) ? [] : ['invented_text'],
  }
}
