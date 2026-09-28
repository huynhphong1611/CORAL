import { z } from 'zod'

/** Error body of every failed request (contracts/rest-api.md). */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z
      .array(z.object({ path: z.string(), code: z.string(), message: z.string() }))
      .optional(),
  }),
})
export type ApiError = z.infer<typeof apiErrorSchema>

export const idParamsSchema = z.object({ id: z.uuid() })
export const timestamp = z.iso.datetime({ offset: true })
export const commitSha = z.string().regex(/^[0-9a-f]{7,64}$/)
export const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)

export function page<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), next_cursor: z.string().nullable() })
}
