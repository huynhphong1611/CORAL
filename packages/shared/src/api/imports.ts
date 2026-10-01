import { z } from 'zod'
import { MAX_LIMIT_USD } from '../brains/schema'
import {
  IMPORT_FORMATS,
  MAX_IMPORT_CASES,
  importMappingSchema,
  manualCaseSchema,
} from '../manualcase/schema'
import { commitSha, timestamp } from './common'

// Values of data-model §1, verbatim: the DB check constraints use the same lists.

export const IMPORT_JOB_STATUSES = ['preview', 'running', 'done', 'cancelled', 'failed'] as const
export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number]

export const IMPORT_ITEM_STATUSES = [
  'pending',
  'running',
  'active',
  'draft',
  'not_processed',
] as const
export type ImportItemStatus = (typeof IMPORT_ITEM_STATUSES)[number]

export const IMPORT_ITEM_REASONS = [
  'needs_human',
  'ambiguous',
  'app_mismatch',
  'validation_failed',
  'duplicate',
] as const
export type ImportItemReason = (typeof IMPORT_ITEM_REASONS)[number]

const count = z.number().int().nonnegative()

/** Progress of an import job (`import.updated`, `GET /imports/:id`). */
export const importStatsSchema = z.object({
  total: count,
  done: count,
  active: count,
  draft: count,
  not_processed: count,
  cost_usd: z.number().nonnegative(),
})
export type ImportStats = z.infer<typeof importStatsSchema>

/** `import_jobs.budget`; `POST /imports/:id/start` fills what the body leaves out. */
export const importBudgetSchema = z.object({
  max_cost_usd: z.number().positive().max(MAX_LIMIT_USD),
  max_minutes: z.number().int().min(1).max(1440),
})
export type ImportBudget = z.infer<typeof importBudgetSchema>

/** `POST /projects/:id/imports` (multipart fields besides `file`). */
export const createImportFieldsSchema = z.object({
  format: z.enum(IMPORT_FORMATS).optional(),
  sheet: z.string().min(1).max(100).optional(),
})

/** What the file holds under a mapping (`POST /projects/:id/imports`, `PATCH /imports/:id`). */
export const importPreviewSchema = z.object({
  import_job_id: z.uuid(),
  format: z.enum(IMPORT_FORMATS),
  file_name: z.string(),
  columns: z.array(z.object({ index: z.number().int().nonnegative(), header: z.string() })),
  // Gherkin needs no mapping.
  mapping: importMappingSchema.nullable(),
  cases: z.array(manualCaseSchema).max(MAX_IMPORT_CASES),
  errors: z.array(
    z.object({
      row: z.number().int().positive().optional(),
      line: z.number().int().positive().optional(),
      message: z.string(),
    }),
  ),
})
export type ImportPreview = z.infer<typeof importPreviewSchema>

export const patchImportSchema = z.object({ mapping: importMappingSchema })

export const startImportSchema = z.object({
  app_id: z.uuid(),
  build_id: z.uuid(),
  device_id: z.uuid(),
  budget: importBudgetSchema.partial().optional(),
})
export type StartImport = z.infer<typeof startImportSchema>

export const importJobSchema = z.object({
  id: z.uuid(),
  project_id: z.uuid(),
  // Chosen at start; null while in preview.
  app_id: z.uuid().nullable(),
  build_id: z.uuid().nullable(),
  device_id: z.uuid().nullable(),
  source_format: z.enum(IMPORT_FORMATS),
  file_name: z.string(),
  status: z.enum(IMPORT_JOB_STATUSES),
  budget: importBudgetSchema.nullable(),
  stats: importStatsSchema,
  manual_commit: commitSha.nullable(),
  created_by: z.object({ id: z.uuid(), name: z.string() }),
  created_at: timestamp,
  started_at: timestamp.nullable(),
  finished_at: timestamp.nullable(),
})
export type ImportJob = z.infer<typeof importJobSchema>

export const importItemSchema = z.object({
  n: z.number().int().positive(),
  title: z.string(),
  status: z.enum(IMPORT_ITEM_STATUSES),
  reason: z.enum(IMPORT_ITEM_REASONS).nullable(),
  // Where the AI stopped and why, for a case it could not turn into a test.
  evidence: z
    .object({
      step_n: z.number().int().positive().optional(),
      screenshot_url: z.url().optional(),
      message: z.string(),
    })
    .nullable(),
  exploration_id: z.uuid().nullable(),
  test_case_id: z.uuid().nullable(),
})
export type ImportItem = z.infer<typeof importItemSchema>

/** `import_jobs.report` once the job ended (data-model §3). */
export const importReportSchema = z.object({
  total: count,
  active: count,
  draft: z.object(
    Object.fromEntries(IMPORT_ITEM_REASONS.map((r) => [r, count])) as Record<
      ImportItemReason,
      typeof count
    >,
  ),
  not_processed: count,
  cost_usd: z.number().nonnegative(),
  items: z.array(
    z.object({
      n: z.number().int().positive(),
      title: z.string(),
      status: z.enum(IMPORT_ITEM_STATUSES),
      test_case_id: z.uuid().optional(),
    }),
  ),
})
export type ImportReport = z.infer<typeof importReportSchema>

/** `GET /imports/:id`. */
export const importJobDetailSchema = importJobSchema.extend({
  items: z.array(importItemSchema),
  report: importReportSchema.nullable(),
})
export type ImportJobDetail = z.infer<typeof importJobDetailSchema>

export const listImportsQuerySchema = z.object({ project_id: z.uuid() })
