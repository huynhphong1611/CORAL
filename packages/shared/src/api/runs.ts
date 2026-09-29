import { z } from 'zod'
import { FAILURE_CODES } from '../failure-codes'
import { commitSha, timestamp } from './common'

const failureCode = z.enum(FAILURE_CODES)

export const createRunSchema = z.object({
  project_id: z.uuid(),
  build_id: z.uuid(),
  device_id: z.uuid(),
  test_case_ids: z.array(z.uuid()).min(1).max(50),
})

export const RUN_STATUSES = ['queued', 'running', 'passed', 'failed', 'cancelled', 'error'] as const
export const RUN_ITEM_STATUSES = [
  'pending',
  'running',
  'passed',
  'failed',
  'skipped',
  'error',
] as const

export const runItemSchema = z.object({
  id: z.uuid(),
  test_case_id: z.uuid(),
  slug: z.string().optional(),
  commit: commitSha,
  position: z.number().int().nonnegative(),
  status: z.enum(RUN_ITEM_STATUSES),
  failure_code: failureCode.nullable(),
  failed_step_id: z.string().nullable(),
})

export const runSchema = z.object({
  id: z.uuid(),
  project_id: z.uuid(),
  build_id: z.uuid(),
  device_id: z.uuid(),
  status: z.enum(RUN_STATUSES),
  failure_code: failureCode.nullable(),
  queued_at: timestamp,
  started_at: timestamp.nullable(),
  finished_at: timestamp.nullable(),
  items: z.array(runItemSchema),
})

export const listRunsQuerySchema = z.object({
  project_id: z.uuid().optional(),
  status: z.enum(RUN_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
})

export const runStepSchema = z.object({
  step_index: z.number().int().nonnegative(),
  step_id: z.string(),
  action: z.string(),
  status: z.enum(['passed', 'failed']),
  locator_used_index: z.number().int().nullable(),
  degraded: z.boolean(),
  unstable: z.boolean(),
  duration_ms: z.number().int().nonnegative(),
  failure_code: failureCode.nullable(),
  message: z.string().nullable(),
  popups_handled: z.array(z.object({ rule: z.string(), button: z.string() })),
  artifacts: z.object({
    screenshot_url: z.url().nullable(),
    tree_url: z.url().nullable(),
    log_url: z.url().nullable(),
  }),
})

export const readinessSchema = z.object({ status: z.enum(['ok', 'not_ready']) })

export type CreateRun = z.infer<typeof createRunSchema>
export type Run = z.infer<typeof runSchema>
export type RunItem = z.infer<typeof runItemSchema>
export type RunStep = z.infer<typeof runStepSchema>
export type Readiness = z.infer<typeof readinessSchema>
