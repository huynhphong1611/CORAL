import type { TestCase } from './schema'

const SECRET = /\$\{secret:([^}]*)\}/g

function collectStrings(value: unknown, out: string[]): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out)
  else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out)
  }
  return out
}

/**
 * Secret names a test case uses, in `variables` or directly in steps (sorted, unique). Used by
 * `coral run`, the server when creating a run (`missing_secrets`) and `job.assign`.
 */
export function referencedSecrets(testCase: TestCase): string[] {
  const names = new Set<string>()
  for (const text of collectStrings([testCase.variables ?? {}, testCase.steps], [])) {
    for (const [, name] of text.matchAll(SECRET)) if (name) names.add(name)
  }
  return [...names].sort()
}
