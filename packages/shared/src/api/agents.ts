import { z } from 'zod'
import { timestamp } from './common'

export const createAgentSchema = z.object({ name: z.string().trim().min(1).max(100) })

export const agentSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: z.enum(['online', 'offline', 'revoked']),
  os: z.string().nullable(),
  version: z.string().nullable(),
  last_seen_at: timestamp.nullable(),
})

export type Agent = z.infer<typeof agentSchema>

/** Returned once by POST /agents — the token is never shown again (FR-020). */
export const createdAgentSchema = agentSchema.pick({ id: true, name: true }).extend({
  token: z.string().regex(/^coral_agt_[A-Za-z0-9_-]{20,}$/),
})

export const deviceSchema = z.object({
  id: z.uuid(),
  agent_id: z.uuid(),
  platform: z.literal('android'),
  kind: z.enum(['real', 'emulator', 'simulator']),
  model: z.string(),
  os_version: z.string(),
  api_level: z.number().int().nullable(),
  udid: z.string(),
  status: z.enum(['idle', 'leased', 'offline']),
})
export type Device = z.infer<typeof deviceSchema>
export type CreatedAgent = z.infer<typeof createdAgentSchema>
