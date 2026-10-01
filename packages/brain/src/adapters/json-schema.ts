/**
 * JSON Schema for providers' structured output and strict tools (research R2): the subset they
 * compile — types, `properties`/`required`, `items`, `enum`/`const`, `anyOf`/`allOf`, a few string
 * formats, `minItems` 0 or 1 — with every object closed (`additionalProperties: false`). Other
 * constraints (lengths, ranges, patterns) move into the description: the Zod schema still checks
 * them on the answer, and a broken answer is re-asked (structured.ts).
 */

const FORMATS = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
])
const KEPT = new Set(['type', 'description', 'title', 'enum', 'const', 'required'])
const MAX_DEPTH = 32

type Schema = Record<string, unknown>

class Unsupported extends Error {}

export interface StrictSchemaOptions {
  /** `const: x` written as `enum: [x]`, for providers that know no `const` (Gemini). */
  constAsEnum?: boolean
}

const isSchema = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function convert(node: unknown, depth: number, options: StrictSchemaOptions): Schema {
  if (depth > MAX_DEPTH || !isSchema(node)) throw new Unsupported('not a schema')
  const out: Schema = {}
  const moved: Schema = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === '$schema' || key === 'additionalProperties') continue
    if (key === 'const' && options.constAsEnum) {
      out.enum = [value]
    } else if (KEPT.has(key)) {
      out[key] = value
    } else if (key === 'properties') {
      if (!isSchema(value)) throw new Unsupported('properties')
      out.properties = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, convert(child, depth + 1, options)]),
      )
    } else if (key === 'items') {
      // `items: false` closes a tuple (`prefixItems`), handled below.
      if (value !== false) out.items = convert(value, depth + 1, options)
    } else if (key === 'prefixItems') {
      // A tuple becomes an array of its item types; its length stays in the description.
      if (!Array.isArray(value) || value.length === 0) throw new Unsupported(key)
      const kinds = [...new Set(value.map((child) => JSON.stringify(child)))]
      out.items =
        kinds.length === 1
          ? convert(value[0], depth + 1, options)
          : { anyOf: value.map((child) => convert(child, depth + 1, options)) }
      moved.items = `${value.length} items`
    } else if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
      if (!Array.isArray(value)) throw new Unsupported(key)
      // Exactly one of a discriminated union matches anyway: `oneOf` reads as `anyOf`.
      out[key === 'allOf' ? 'allOf' : 'anyOf'] = value.map((child) =>
        convert(child, depth + 1, options),
      )
    } else if (key === '$ref' || key === '$defs' || key === 'definitions') {
      // References may be recursive, which providers cannot compile.
      throw new Unsupported('references')
    } else if (key === 'format' && typeof value === 'string' && FORMATS.has(value)) {
      out.format = value
    } else if (key === 'minItems' && (value === 0 || value === 1)) {
      out.minItems = value
    } else {
      moved[key] = value
    }
  }
  const typed = ['type', 'anyOf', 'allOf', 'enum', 'const'].some((key) => key in out)
  if (!typed) throw new Unsupported('a schema without a type')
  if (out.type === 'object' || 'properties' in out) {
    out.properties ??= {}
    out.additionalProperties = false
  }
  const extra = Object.entries(moved)
  if (extra.length > 0) {
    const note = `{${extra.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ')}}`
    out.description = typeof out.description === 'string' ? `${out.description}\n\n${note}` : note
  }
  return out
}

/** The schema in the strict subset, or undefined when it cannot be (references, no type). */
export function strictSchema(
  schema: unknown,
  options: StrictSchemaOptions = {},
): Schema | undefined {
  try {
    return convert(schema, 0, options)
  } catch (error) {
    if (error instanceof Unsupported) return undefined
    throw error
  }
}
