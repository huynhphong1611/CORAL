/** Secrets shorter than this are not masked: they would match ordinary text (research R13). */
export const MIN_SECRET_LENGTH = 4
export const MASK = '***'

export interface Redactor {
  /** Replaces every occurrence of a secret value in a string. */
  text(input: string): string
  /** Deep copy of a JSON-like value with every string redacted. */
  value<T>(input: T): T
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Builds a redactor for the secret values used by one run (SPEC §8.6, D19). */
export function createRedactor(secrets: Iterable<string>): Redactor {
  const values = [...new Set(secrets)]
    .filter((value) => value.length >= MIN_SECRET_LENGTH)
    // Longest first so a secret that contains another is masked as a whole.
    .sort((a, b) => b.length - a.length)
  const pattern = values.length > 0 ? new RegExp(values.map(escapeRegExp).join('|'), 'gu') : null

  const text = (input: string): string => (pattern ? input.replace(pattern, MASK) : input)

  const value = <T>(input: T): T => {
    if (!pattern) return input
    if (typeof input === 'string') return text(input) as T
    if (Array.isArray(input)) return input.map((item: unknown) => value(item)) as T
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, value(v)]),
      ) as T
    }
    return input
  }

  return { text, value }
}
