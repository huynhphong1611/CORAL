import { z } from 'zod'

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
