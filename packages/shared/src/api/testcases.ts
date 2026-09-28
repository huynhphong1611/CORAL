import { z } from 'zod'
import { commitSha, timestamp } from './common'

const issue = z.object({
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
  status: z.enum(['draft', 'active', 'quarantined']),
  head_commit: commitSha,
  source: z.enum(['manual', 'recorder', 'ai_prompt', 'ai_import']),
  updated_at: timestamp,
})

export const createTestCaseSchema = z.object({ yaml: z.string().min(1).max(1_000_000) })
export const updateTestCaseSchema = createTestCaseSchema.extend({ base_commit: commitSha })

export const savedTestCaseSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  head_commit: commitSha,
  warnings: z.array(issue),
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
