import { referencedSecrets, type TestCase } from '@coral/shared'

const PATTERN = /\$\{(secret|var):([^}]*)\}/g

export { referencedSecrets }

export class InterpolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InterpolationError'
  }
}

/** Secret names without a value; checked before the run touches the device (FR-012). */
export function missingSecrets(
  testCase: TestCase,
  secrets: Readonly<Record<string, string | undefined>>,
): string[] {
  return referencedSecrets(testCase).filter((name) => secrets[name] === undefined)
}

export interface Interpolator {
  (text: string): string
  /** Every secret value in use, for the redactor. */
  readonly secretValues: string[]
}

/**
 * Replaces `${secret:NAME}` and `${var:name}` (SPEC §7.4). Variable values may reference
 * secrets; they are resolved once. Unknown names throw (validate catches them earlier).
 */
export function createInterpolator(
  testCase: TestCase,
  secrets: Readonly<Record<string, string | undefined>>,
): Interpolator {
  const secret = (name: string) => {
    const value = secrets[name]
    if (value === undefined) throw new InterpolationError(`secret ${name} is not set`)
    return value
  }
  const variables = new Map<string, string>()
  for (const [name, raw] of Object.entries(testCase.variables ?? {})) {
    variables.set(
      name,
      raw.replace(PATTERN, (match, kind: string, key: string) =>
        kind === 'secret' ? secret(key) : match,
      ),
    )
  }
  const interpolate = (text: string): string =>
    text.replace(PATTERN, (_match, kind: string, key: string) => {
      if (kind === 'secret') return secret(key)
      const value = variables.get(key)
      if (value === undefined) throw new InterpolationError(`variable ${key} is not declared`)
      return value
    })
  const secretValues = referencedSecrets(testCase)
    .map((name) => secrets[name])
    .filter((v): v is string => v !== undefined)
  return Object.assign(interpolate, { secretValues })
}
