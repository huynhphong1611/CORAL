import { z } from 'zod'
import { envelopeSchema } from './envelope'

export type ParseFailure = {
  ok: false
  code: 'too_large' | 'invalid_json' | 'invalid_message'
  message: string
  id?: string
}

/** UTF-8 byte length without Node or DOM globals (this package runs in both). */
export function utf8Length(text: string): number {
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

/**
 * Parses one raw WebSocket text frame against a table of payload schemas (D18): size limit, JSON,
 * envelope, known type, `re` on replies, payload. Never throws.
 */
export function parseEnvelope<Types extends string>(
  raw: string,
  options: {
    schemas: Record<Types, z.ZodType>
    replyTypes: ReadonlySet<Types>
    maxBytes: number
  },
):
  | { ok: true; type: Types; envelope: z.infer<typeof envelopeSchema>; payload: unknown }
  | ParseFailure {
  if (utf8Length(raw) > options.maxBytes) {
    return { ok: false, code: 'too_large', message: `message exceeds ${options.maxBytes} bytes` }
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, code: 'invalid_json', message: 'message is not valid JSON' }
  }
  const env = envelopeSchema.safeParse(json)
  if (!env.success) {
    const id = (json as { id?: unknown } | null)?.id
    return {
      ok: false,
      code: 'invalid_message',
      message: z.prettifyError(env.error),
      ...(typeof id === 'string' ? { id } : {}),
    }
  }
  const { type, id, re } = env.data
  if (!Object.hasOwn(options.schemas, type)) {
    return { ok: false, code: 'invalid_message', message: `unknown type "${type}"`, id }
  }
  const known = type as Types
  if (options.replyTypes.has(known) && !re) {
    return { ok: false, code: 'invalid_message', message: `"${type}" must carry "re"`, id }
  }
  const payload = options.schemas[known].safeParse(env.data.payload)
  if (!payload.success) {
    return { ok: false, code: 'invalid_message', message: z.prettifyError(payload.error), id }
  }
  return { ok: true, type: known, envelope: env.data, payload: payload.data }
}
