import { validateTestCaseSource, type TestCase } from '@coral/shared'
import { useEffect, useState } from 'react'
import { en } from '../../i18n/en'

/** How long the editor waits after the last keystroke before checking (≤ 1 s, US5). */
export const CHECK_MS = 300

/** A problem in the editor: `coral validate`'s shape, or one the server found on save. */
export interface Problem {
  code: string
  message: string
  path: string
  step_id?: string | undefined
  line?: number | undefined
  column?: number | undefined
}

export interface Checked {
  errors: Problem[]
  warnings: Problem[]
  /** The parsed test case when the schema accepted it (for the step pictures). */
  testCase?: TestCase | undefined
}

/**
 * Checks the text like `coral validate` (FR-018), in the browser, plus what only the editor
 * knows: the `id` is the test case's slug and cannot change here.
 */
export function checkTestCase(text: string, slug: string): Checked {
  const result = validateTestCaseSource(text, `${slug}.yaml`)
  const errors: Problem[] = [...result.errors]
  if (result.value && result.value.id !== slug) {
    const line = text.split('\n').findIndex((l) => /^id\s*:/.test(l))
    errors.push({
      code: 'id_changed',
      message: en.editor.idChanged(slug),
      path: 'id',
      ...(line >= 0 ? { line: line + 1, column: 1 } : {}),
    })
  }
  return { errors, warnings: [...result.warnings], testCase: result.value }
}

/** `value` once it has not changed for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}
