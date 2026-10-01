import { z } from 'zod'
import { actionDecisionSchema, WRITE_OUTCOMES } from '../ai/decisions'
import {
  APPMAP_SCHEMA_ID,
  FINGERPRINT_PATTERN,
  SCREEN_ID_PATTERN,
  appMapScreenSchema,
  appMapTransitionSchema,
  transitionActionSchema,
} from '../appmap/schema'
import { MAX_LIMIT_USD } from '../brains/schema'
import { stepSchema } from '../testcase/schema'
import { timestamp } from './common'
import {
  DRAFT_REASONS,
  TEST_CASE_FLAGS,
  TEST_CASE_STATUSES,
  testCaseValidationSchema,
} from './testcases'

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
  max_cost_usd: z.number().positive().max(MAX_LIMIT_USD),
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
  // Set once the app map reached its limits and new screens were no longer added.
  appmap_full: z.boolean().optional(),
})
export type ExplorationStats = z.infer<typeof explorationStatsSchema>

/** Why a flow the Test writer chose became no test case (US3 scenarios 6–7, D48). */
export const WRITER_SKIP_REASONS = ['duplicate', 'invalid', 'no_steps'] as const
/** Why the Test writer wrote nothing at all. */
export const WRITER_ERRORS = ['budget', 'ai_unavailable', 'invalid_output'] as const

/** `explorations.writer_report`: what the Test writer did with the flows it chose (D48). */
export const writerReportSchema = z.object({
  flows: count,
  skipped: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      intent: z.string(),
      reason: z.enum(WRITER_SKIP_REASONS),
      // `duplicate`: the project's test case with the same steps.
      duplicate_of: z.string().optional(),
      // `invalid` / `no_steps`: what was wrong with it.
      message: z.string().optional(),
    }),
  ),
  error: z.enum(WRITER_ERRORS).nullable(),
  // An imported case (US6): how the writer says it went, the step that shows it and why.
  outcome: z.enum(WRITE_OUTCOMES).optional(),
  evidence_step: z.number().int().positive().optional(),
  explanation: z.string().optional(),
})
export type WriterReport = z.infer<typeof writerReportSchema>

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

/** Defaults of `POST /explorations`; `max_cost_usd` comes from `limits` of brains.yaml. */
export const DEFAULT_EXPLORATION_BUDGET = { max_steps: 60, max_depth: 8, max_minutes: 20 } as const
export const DEFAULT_MAX_TESTS = 5
/** A goal (US5) asks for one test case unless the body says otherwise. */
export const DEFAULT_MAX_TESTS_WITH_GOAL = 1
export const MAX_TESTS_LIMIT = 20
export const MAX_GOAL_LENGTH = 1000

/** `POST /explorations`: a goal makes it `kind = prompt`. */
export const createExplorationSchema = z.object({
  project_id: z.uuid(),
  app_id: z.uuid(),
  build_id: z.uuid(),
  device_id: z.uuid(),
  goal: z.string().trim().min(1).max(MAX_GOAL_LENGTH).optional(),
  budget: explorationBudgetSchema.partial().optional(),
  max_tests: z.number().int().min(1).max(MAX_TESTS_LIMIT).optional(),
})
export type CreateExploration = z.infer<typeof createExplorationSchema>

export const explorationSchema = z.object({
  id: z.uuid(),
  project_id: z.uuid(),
  app_id: z.uuid(),
  build_id: z.uuid(),
  device_id: z.uuid(),
  kind: z.enum(EXPLORATION_KINDS),
  goal: z.string().nullable(),
  budget: explorationBudgetSchema,
  max_tests: z.number().int().min(1).max(MAX_TESTS_LIMIT),
  status: z.enum(EXPLORATION_STATUSES),
  stop_reason: z.enum(STOP_REASONS).nullable(),
  stats: explorationStatsSchema,
  created_by: z.object({ id: z.uuid(), name: z.string() }),
  created_at: timestamp,
  started_at: timestamp.nullable(),
  finished_at: timestamp.nullable(),
})
export type Exploration = z.infer<typeof explorationSchema>

export const listExplorationsQuerySchema = z.object({
  project_id: z.uuid().optional(),
  status: z.enum(EXPLORATION_STATUSES).optional(),
})
export type ListExplorationsQuery = z.infer<typeof listExplorationsQuerySchema>

/** `GET /explorations/:id/steps?after=<n>&limit=`. */
export const explorationStepsQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

/** A crash or ANR the Explorer met: a bug candidate for Phase 4. */
export const findingSchema = z.object({
  id: z.uuid(),
  step_n: z.number().int().positive(),
  kind: z.enum(FINDING_KINDS),
  log_excerpt: z.string(),
  screenshot_url: z.url().nullable(),
  created_at: timestamp,
})
export type Finding = z.infer<typeof findingSchema>

/** The screens and transitions one exploration saw, with presigned screenshot URLs. */
export const explorationAppMapSchema = z.object({
  screens: z.array(
    z.object({
      id: screenIdSchema,
      name: z.string(),
      fingerprint: fingerprintSchema,
      is_new: z.boolean(),
      screenshot_url: z.url().nullable(),
    }),
  ),
  transitions: z.array(
    z.object({ from: screenIdSchema, to: screenIdSchema, action: transitionActionSchema }),
  ),
})
export type ExplorationAppMap = z.infer<typeof explorationAppMapSchema>

/** `GET /explorations/:id`. */
export const explorationDetailSchema = explorationSchema.extend({
  appmap: explorationAppMapSchema,
  test_cases: z.array(
    z.object({
      id: z.uuid(),
      slug: z.string(),
      status: z.enum(TEST_CASE_STATUSES),
      draft_reason: z.enum(DRAFT_REASONS).nullable(),
      flags: z.array(z.enum(TEST_CASE_FLAGS)),
      validation: testCaseValidationSchema.nullable(),
    }),
  ),
  findings: z.array(findingSchema),
  // Null until the Test writer ran (and for an exploration it never ran on).
  writer_report: writerReportSchema.nullable(),
})
export type ExplorationDetail = z.infer<typeof explorationDetailSchema>

/**
 * `GET /projects/:id/appmap`: `coral/appmap@1` at the head commit (empty when there is none), each
 * screen with the URL of its picture through `GET /projects/:id/files/*` at that commit.
 */
export const projectAppMapSchema = z.object({
  schema: z.literal(APPMAP_SCHEMA_ID),
  head_commit: z.string(),
  screens: z.array(appMapScreenSchema.extend({ screenshot_url: z.string() })),
  transitions: z.array(appMapTransitionSchema),
})
export type ProjectAppMap = z.infer<typeof projectAppMapSchema>
