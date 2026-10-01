import { z } from 'zod'
import { SECRET_NAME_PATTERN } from '../protocol/device-command'
import { DIRECTIONS, TESTCASE_ID_PATTERN } from '../testcase/schema'

/**
 * What the AI roles answer (SPEC §14.1, contracts/brain.md §3). Every answer is checked against
 * these schemas before anything is done with it (FR-002); the JSON Schema sent to a provider is
 * generated from the same schemas (`toJsonSchema`). The schemas stay flat — no recursion, every
 * object strict — so each provider's structured-output mode accepts them.
 */

/** Longest text the Explorer may make up and type (FR-022a). */
export const MAX_TYPED_TEXT = 64
/** Longest reason an AI gives for a decision. */
export const MAX_REASON = 300

const reason = z.string().trim().min(1).max(MAX_REASON)
/** An element of the numbered list of the current screen (`#1`…). */
const element = z.number().int().min(1).max(999)
const secretName = z.string().regex(SECRET_NAME_PATTERN, 'a secret name')
const dataName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'a test_data name')

/** `describeScreen`: a short name for a screen of the app map and what it is for. */
export const screenSummarySchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
  purpose: z.string().trim().max(MAX_REASON),
})
export type ScreenSummary = z.infer<typeof screenSummarySchema>

const typeDecision = z
  .strictObject({
    action: z.literal('type'),
    element,
    text: z.string().min(1).max(MAX_TYPED_TEXT).optional(),
    secret: secretName.optional(),
    test_data: dataName.optional(),
    reason,
  })
  .refine(
    (d) => [d.text, d.secret, d.test_data].filter((v) => v !== undefined).length === 1,
    'type carries exactly one of text, secret, test_data',
  )

/** `nextAction`: one action on the current screen, by element number (§10, §14.1). */
export const actionDecisionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('tap'), element, reason }),
  z.strictObject({ action: z.literal('long_press'), element, reason }),
  typeDecision,
  z.strictObject({ action: z.literal('swipe'), element, direction: z.enum(DIRECTIONS), reason }),
  z.strictObject({ action: z.literal('back'), reason }),
  z.strictObject({ action: z.literal('hide_keyboard'), reason }),
  z.strictObject({ action: z.literal('restart_app'), reason }),
  // Only when the screen offers no usable element (canvas, Flutter without Semantics — P2).
  z.strictObject({
    action: z.literal('tap_point'),
    point_pct: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
    reason,
  }),
  // Goal mode: the goal is reached, or cannot be (e.g. it needs a never_tap button).
  z.strictObject({ action: z.literal('done'), goal_reached: z.boolean(), reason }),
])
export type ActionDecision = z.infer<typeof actionDecisionSchema>
export type DecisionAction = ActionDecision['action']

/**
 * An expectation the writer keeps for a trace step: a text that must be on the screen after it,
 * or one of the candidates the system listed for that step (the Recorder's suggestions, with
 * locators read from the tree — the AI never writes a locator, P2).
 */
const flowExpectSchema = z
  .strictObject({
    step: z.number().int().min(1),
    visible_text: z.string().trim().min(1).max(200).optional(),
    candidate: z.number().int().min(0).max(20).optional(),
  })
  .refine(
    (e) => (e.visible_text === undefined) !== (e.candidate === undefined),
    'an expectation is either visible_text or candidate',
  )

export const flowSchema = z.strictObject({
  slug: z.string().regex(TESTCASE_ID_PATTERN, 'slug must match [a-z0-9][a-z0-9-]{1,63}'),
  name: z.string().trim().min(1).max(80),
  intent: z.string().trim().min(1).max(MAX_REASON),
  segment: z.number().int().min(0),
  end_step: z.number().int().min(1),
  expects: z.array(flowExpectSchema).max(30),
})
export type Flow = z.infer<typeof flowSchema>

export const WRITE_OUTCOMES = ['written', 'needs_human', 'ambiguous', 'app_mismatch'] as const
export type WriteOutcome = (typeof WRITE_OUTCOMES)[number]

/** `writeTest`: flows chosen from the trace; for an import, also how the manual case went. */
export const testPlanSchema = z
  .strictObject({
    flows: z.array(flowSchema).max(20),
    outcome: z.enum(WRITE_OUTCOMES),
    evidence_step: z.number().int().min(1).optional(),
    explanation: z.string().trim().max(500).optional(),
  })
  .refine(
    (p) => p.outcome === 'written' || (p.explanation !== undefined && p.explanation.length > 0),
    'an outcome other than written needs an explanation',
  )
export type TestPlan = z.infer<typeof testPlanSchema>

/** JSON Schema of an answer for a provider's structured-output mode (research R3). */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })
}
