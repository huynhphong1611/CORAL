import { z } from 'zod'
import { newId } from '../ids'

export const PROTOCOL_VERSION = 1
/** Largest accepted WebSocket message; artifacts go through S3, never through WS. */
export const MAX_MESSAGE_BYTES = 1_000_000

/** `{ v, type, id, ts, re?, payload }` — SPEC §15, D18. */
export const envelopeSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.string().min(1),
  id: z.uuid(),
  ts: z.number().int().nonnegative(),
  re: z.uuid().optional(),
  payload: z.unknown(),
})
export type Envelope = z.infer<typeof envelopeSchema>

export function envelope<T extends string, P>(
  type: T,
  payload: P,
  re?: string,
): { v: 1; type: T; id: string; ts: number; re?: string; payload: P } {
  return { v: PROTOCOL_VERSION, type, id: newId(), ts: Date.now(), ...(re ? { re } : {}), payload }
}
