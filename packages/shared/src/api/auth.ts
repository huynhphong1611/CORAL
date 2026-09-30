import { z } from 'zod'

export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const

export const loginRequestSchema = z.object({ email: z.email(), password: z.string().min(1) })
export const refreshRequestSchema = z.object({ refresh_token: z.string().min(1).optional() })

export const sessionSchema = z.object({
  access_token: z.string(),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().optional(),
  user: z.object({ id: z.uuid(), email: z.email(), name: z.string() }),
  tenant: z.object({ id: z.uuid(), name: z.string(), role: z.enum(ROLES) }),
})
export type Session = z.infer<typeof sessionSchema>

export const meSchema = sessionSchema.pick({ user: true, tenant: true })
export type Me = z.infer<typeof meSchema>
