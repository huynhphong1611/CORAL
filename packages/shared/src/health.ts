import { z } from 'zod'

/** Response of `GET /health` on coral-server (SPEC §16). Wire fields are snake_case (D12). */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('coral-server'),
  version: z.string().min(1),
  uptime_sec: z.number().nonnegative(),
})

export type HealthResponse = z.infer<typeof healthResponseSchema>
