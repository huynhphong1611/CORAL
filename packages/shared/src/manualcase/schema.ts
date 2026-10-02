import { z } from 'zod'

/**
 * `coral/manualcase@1` — a manual test case brought in by an import, in a neutral form kept in the
 * project repo at `imports/<job_id>/<nnn>-<slug>.yaml` (SPEC §11.3, D31, D42,
 * contracts/manualcase.md). The written text is kept as is: expected results are never changed
 * to match the app (P3).
 */
export const MANUALCASE_SCHEMA_ID = 'coral/manualcase@1'
export const MAX_MANUAL_TITLE = 200
/** Longest cell or step text read from a file. */
export const MAX_MANUAL_TEXT = 4000
export const MAX_IMPORT_CASES = 200
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024
export const IMPORT_FORMATS = ['csv', 'xlsx', 'gherkin'] as const
export type ImportFormat = (typeof IMPORT_FORMATS)[number]

const text = z.string().trim().min(1).max(MAX_MANUAL_TEXT)

export const manualStepSchema = z.strictObject({
  action: text,
  expected: text.optional(),
})

export const manualCaseSchema = z.strictObject({
  schema: z.literal(MANUALCASE_SCHEMA_ID),
  id: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(MAX_MANUAL_TITLE),
  preconditions: z.array(text).default([]),
  steps: z.array(manualStepSchema).min(1),
  tags: z.array(z.string().trim().min(1).max(100)).default([]),
  source: z.strictObject({
    file: z.string().min(1),
    row: z.number().int().min(1).optional(),
    line: z.number().int().min(1).optional(),
  }),
})
export type ManualCase = z.infer<typeof manualCaseSchema>
export type ManualStep = z.infer<typeof manualStepSchema>

/** Which columns of a CSV/XLSX hold what (0-based indexes; contracts/rest-api-phase3.md). */
export const importMappingSchema = z.strictObject({
  title: z.number().int().min(0),
  preconditions: z.number().int().min(0).optional(),
  steps: z.array(z.number().int().min(0)).min(1),
  expected: z.array(z.number().int().min(0)).default([]),
  id: z.number().int().min(0).optional(),
  header_row: z.number().int().min(0).default(0),
})
export type ImportMapping = z.infer<typeof importMappingSchema>

/** ASCII slug of a manual case title for its file name (≤ 50 characters). */
export function manualCaseSlug(title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '')
  return slug || 'case'
}

/** Repo path of the n-th (1-based) manual case of an import job. */
export function manualCasePath(jobId: string, n: number, title: string): string {
  return `imports/${jobId}/${String(n).padStart(3, '0')}-${manualCaseSlug(title)}.yaml`
}
