import { z } from 'zod'
import { FAILURE_CODES } from '../failure-codes'
import { commitSha, timestamp } from './common'
import { RUN_STATUSES } from './runs'

export const TEST_CASE_STATUSES = ['draft', 'active', 'quarantined'] as const
export type TestCaseStatus = (typeof TEST_CASE_STATUSES)[number]

export const TEST_CASE_SOURCES = [
  'manual',
  'recorder',
  'ai_explore',
  'ai_prompt',
  'ai_import',
] as const
export type TestCaseSource = (typeof TEST_CASE_SOURCES)[number]

/** Why an AI-written test case stays a draft (data-model §1, D41). */
export const DRAFT_REASONS = [
  'validation_failed',
  'changed_during_validation',
  'needs_human',
  'ambiguous',
  'app_mismatch',
] as const
export type DraftReason = (typeof DRAFT_REASONS)[number]

export const TEST_CASE_FLAGS = ['needs_review_never_tap'] as const
export type TestCaseFlag = (typeof TEST_CASE_FLAGS)[number]

/** `test_cases.validation`: the two validation runs of an AI-written test case (FR-030). */
export const testCaseValidationSchema = z.object({
  commit: commitSha,
  runs: z.array(
    z.object({
      run_id: z.uuid(),
      status: z.enum(RUN_STATUSES),
      failure_code: z.enum(FAILURE_CODES).optional(),
      step_id: z.string().optional(),
    }),
  ),
})
export type TestCaseValidation = z.infer<typeof testCaseValidationSchema>

/** A validation problem or warning of a YAML document (Phase 1 contracts/rest-api.md). */
export const validationIssueSchema = z.object({
  path: z.string(),
  code: z.string(),
  message: z.string(),
  step_id: z.string().optional(),
  line: z.number().int().optional(),
  column: z.number().int().optional(),
})

export const testCaseSummarySchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  intent: z.string(),
  tags: z.array(z.string()),
  platforms: z.array(z.string()),
  status: z.enum(TEST_CASE_STATUSES),
  head_commit: commitSha,
  source: z.enum(TEST_CASE_SOURCES),
  // What an AI-written test case came from (its exploration or import item); null otherwise.
  source_ref: z.string().nullable(),
  draft_reason: z.enum(DRAFT_REASONS).nullable(),
  flags: z.array(z.enum(TEST_CASE_FLAGS)),
  validation: testCaseValidationSchema.nullable(),
  updated_at: timestamp,
})

/** `GET /projects/:id/testcases?source=&status=`. */
export const listTestCasesQuerySchema = z.object({
  source: z.enum(TEST_CASE_SOURCES).optional(),
  status: z.enum(TEST_CASE_STATUSES).optional(),
})

/** `PATCH /testcases/:id`: a person changes the status by hand. */
export const patchTestCaseSchema = z.object({ status: z.enum(TEST_CASE_STATUSES) })

export const createTestCaseSchema = z.object({ yaml: z.string().min(1).max(1_000_000) })
export const updateTestCaseSchema = createTestCaseSchema.extend({ base_commit: commitSha })

export const savedTestCaseSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  head_commit: commitSha,
  warnings: z.array(validationIssueSchema),
})

export const testCaseDetailSchema = testCaseSummarySchema.extend({ yaml: z.string() })

export const historyEntrySchema = z.object({
  commit: commitSha,
  author: z.string(),
  message: z.string(),
  created_at: timestamp,
})

export const popupsFileSchema = z.object({ yaml: z.string(), head_commit: commitSha })
export const updatePopupsSchema = z.object({ yaml: z.string().min(1), base_commit: commitSha })

export type TestCaseSummary = z.infer<typeof testCaseSummarySchema>
export type TestCaseDetail = z.infer<typeof testCaseDetailSchema>
export type SavedTestCase = z.infer<typeof savedTestCaseSchema>
export type HistoryEntry = z.infer<typeof historyEntrySchema>
export type PopupsFile = z.infer<typeof popupsFileSchema>

/** Per-step recording snapshots stored with a test case (`snap/<slug>/<step_id>/`, FR-019). */
export const testCaseSnapshotsSchema = z.array(
  z.object({
    step_id: z.string(),
    screen_url: z.string(),
    tree_url: z.string(),
    element_url: z.string().nullable(),
  }),
)

/** Step screenshots of the latest run of a test case: the editor's fallback (FR-019). */
export const lastRunStepsSchema = z.array(
  z.object({
    step_id: z.string(),
    screenshot_url: z.url(),
    run_id: z.uuid(),
    finished_at: timestamp,
  }),
)

export type TestCaseSnapshots = z.infer<typeof testCaseSnapshotsSchema>
export type LastRunSteps = z.infer<typeof lastRunStepsSchema>
