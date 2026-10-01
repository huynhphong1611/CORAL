import { z } from 'zod'
import { actionDecisionSchema } from '../ai/decisions'
import { FINGERPRINT_PATTERN, SCREEN_ID_PATTERN } from '../appmap/schema'
import { stepSchema } from '../testcase/schema'
import { timestamp } from './common'

// Values of data-model §1, verbatim: the DB check constraints use the same lists.

export const EXPLORATION_KINDS = ['explore', 'prompt', 'import'] as const
export type ExplorationKind = (typeof EXPLORATION_KINDS)[number]

export const EXPLORATION_STATUSES = [
  'queued',
  'running',
  'writing',
  'validating',
  'done',
  'stopped',
  'failed',
  'interrupted',
] as const
export type ExplorationStatus = (typeof EXPLORATION_STATUSES)[number]

export const STOP_REASONS = [
  'max_steps',
  'max_depth',
  'max_minutes',
  'budget',
  'daily_limit',
  'goal_reached',
  'goal_not_reached',
  'user_stopped',
  'device_offline',
  'ai_unavailable',
  'interrupted',
  'error',
] as const
export type StopReason = (typeof STOP_REASONS)[number]

export const EXPLORATION_STEP_STATUSES = ['done', 'refused', 'failed', 'popup', 'restart'] as const
export type ExplorationStepStatus = (typeof EXPLORATION_STEP_STATUSES)[number]

/** Why the safety checks turned an AI decision down (SPEC §9.4, research R6). */
export const STEP_REFUSALS = [
  'not_found',
  'not_actionable',
  'never_tap',
  'skill_forbidden',
  'point_pct_not_allowed',
  'invented_submit',
  'invalid_text',
] as const
export type StepRefusal = (typeof STEP_REFUSALS)[number]

export const STEP_FLAGS = ['never_tap', 'mcp_value', 'invented_text'] as const
export type StepFlag = (typeof STEP_FLAGS)[number]

export const FINDING_KINDS = ['crashed', 'not_responding'] as const
export type FindingKind = (typeof FINDING_KINDS)[number]

/** `explorations.budget`; `POST /explorations` fills what the body leaves out. */
export const explorationBudgetSchema = z.object({
  max_steps: z.number().int().min(1).max(500),
  max_depth: z.number().int().min(1).max(50),
  max_minutes: z.number().int().min(1).max(240),
  max_cost_usd: z.number().positive().max(10_000),
})
export type ExplorationBudget = z.infer<typeof explorationBudgetSchema>

const count = z.number().int().nonnegative()

/** `explorations.stats` (data-model §3). */
export const explorationStatsSchema = z.object({
  steps: count,
  refused: count,
  screens: count,
  new_screens: count,
  transitions: count,
  findings: count,
  cost_usd: z.number().nonnegative(),
  tests_written: count,
  tests_active: count,
})
export type ExplorationStats = z.infer<typeof explorationStatsSchema>

export const EMPTY_EXPLORATION_STATS: ExplorationStats = {
  steps: 0,
  refused: 0,
  screens: 0,
  new_screens: 0,
  transitions: 0,
  findings: 0,
  cost_usd: 0,
  tests_written: 0,
  tests_active: 0,
}

export const screenIdSchema = z.string().regex(SCREEN_ID_PATTERN, 'screen id')
export const fingerprintSchema = z.string().regex(FINGERPRINT_PATTERN, '16 hex characters')

/**
 * One step of an exploration trace (`GET /explorations/:id/steps`, `exploration.step`). `screen`
 * is the app map screen the step started on; its id and name are null until the screen is named.
 */
export const explorationStepSchema = z.object({
  n: z.number().int().positive(),
  segment: z.number().int().positive(),
  screen: z.object({
    id: screenIdSchema.nullable(),
    name: z.string().nullable(),
    fingerprint: fingerprintSchema,
  }),
  // Null for steps the system took on its own (a popup handled, a restart).
  decision: actionDecisionSchema.nullable(),
  status: z.enum(EXPLORATION_STEP_STATUSES),
  refusal: z.enum(STEP_REFUSALS).nullable(),
  // The step `record` returned (locator chain, warnings): absent when nothing was done.
  step: stepSchema.nullable(),
  flags: z.array(z.enum(STEP_FLAGS)),
  brain_call_id: z.uuid().nullable(),
  screenshot_url: z.url().nullable(),
  cost_usd: z.number().nonnegative(),
  created_at: timestamp,
})
export type ExplorationStepView = z.infer<typeof explorationStepSchema>
