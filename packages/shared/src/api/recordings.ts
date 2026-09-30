import { z } from 'zod'
import { recordingStepSchema } from '../recording'
import { TESTCASE_ID_PATTERN } from '../testcase/schema'
import { commitSha, timestamp } from './common'
import { validationIssueSchema } from './testcases'

export const RECORDING_STATUSES = ['recording', 'stopped', 'saved', 'discarded', 'expired'] as const

const slug = z.string().regex(TESTCASE_ID_PATTERN, 'slug must match [a-z0-9][a-z0-9-]{1,63}')

/** A recorded step with presigned GET URLs of its snapshot (`GET /recordings/:id`). */
export const recordingStepViewSchema = recordingStepSchema.extend({
  urls: z.object({ screen: z.url(), tree: z.url(), element: z.url().optional() }),
})

/** `Recording` of contracts/rest-api-phase2.md; lists leave `steps` out. */
export const recordingSchema = z.object({
  id: z.uuid(),
  project_id: z.uuid(),
  app_id: z.uuid(),
  build_id: z.uuid(),
  device_id: z.uuid(),
  status: z.enum(RECORDING_STATUSES),
  intent: z.string(),
  slug: z.string(),
  steps: z.array(recordingStepViewSchema).optional(),
  created_by: z.object({ id: z.uuid(), name: z.string() }),
  created_at: timestamp,
  updated_at: timestamp,
  expires_at: timestamp,
  test_case_id: z.uuid().nullable(),
})
export type Recording = z.infer<typeof recordingSchema>

export const createRecordingSchema = z.object({
  project_id: z.uuid(),
  app_id: z.uuid(),
  build_id: z.uuid(),
  device_id: z.uuid(),
})
export type CreateRecording = z.infer<typeof createRecordingSchema>

export const listRecordingsQuerySchema = z.object({
  project_id: z.uuid().optional(),
  status: z.enum(RECORDING_STATUSES).optional(),
})
export type ListRecordingsQuery = z.infer<typeof listRecordingsQuerySchema>

/** Edit, delete, reorder steps and accept suggestions before saving (FR-016). */
export const patchRecordingSchema = z
  .object({
    intent: z.string().max(2000).optional(),
    slug: slug.optional(),
    steps: z.array(recordingStepSchema).optional(),
  })
  .refine((p) => Object.keys(p).length > 0, { message: 'nothing to change' })
export type PatchRecording = z.infer<typeof patchRecordingSchema>

export const recordingYamlSchema = z.object({
  yaml: z.string(),
  warnings: z.array(validationIssueSchema),
})
export type RecordingYaml = z.infer<typeof recordingYamlSchema>

export const saveRecordingSchema = z
  .object({
    slug,
    intent: z.string().min(1).max(2000),
    yaml: z.string().min(1).max(1_000_000),
    // Overwrite an existing test case of that slug (409 slug_exists otherwise).
    replace: z.boolean().optional(),
    base_commit: commitSha.optional(),
  })
  .refine((p) => !p.replace || p.base_commit !== undefined, {
    message: 'replace needs base_commit',
  })

export const savedRecordingSchema = z.object({
  test_case_id: z.uuid(),
  head_commit: commitSha,
  warnings: z.array(validationIssueSchema),
})
