import { z } from 'zod'
import { sha256Hex, timestamp } from './common'

export const createProjectSchema = z.object({ name: z.string().trim().min(1).max(100) })
export const projectSchema = z.object({ id: z.uuid(), name: z.string(), created_at: timestamp })

export const createAppSchema = z.object({
  platform: z.literal('android'),
  package_or_bundle_id: z.string().regex(/^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/),
  name: z.string().trim().min(1).max(100),
})
export const appSchema = createAppSchema.extend({
  id: z.uuid(),
  project_id: z.uuid(),
  created_at: timestamp,
})

export const buildSchema = z.object({
  id: z.uuid(),
  app_id: z.uuid(),
  version: z.string(),
  checksum_sha256: sha256Hex,
  size_bytes: z.number().int().nonnegative(),
  created_at: timestamp,
})
