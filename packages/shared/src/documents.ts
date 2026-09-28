import { POPUPS_SCHEMA_ID, validatePopupsSource } from './popups'
import { TESTCASE_SCHEMA_ID, parseYaml, validateTestCaseSource } from './testcase'
import type { ValidationResult } from './testcase/validate'

export const DOCUMENT_SCHEMAS = [TESTCASE_SCHEMA_ID, POPUPS_SCHEMA_ID] as const

/** Validates a coral YAML file of any kind, picked by its `schema` field. */
export function validateDocumentSource(source: string, file: string): ValidationResult<unknown> {
  const parsed = parseYaml(source)
  const schema = (parsed.value as { schema?: unknown } | null | undefined)?.schema
  if (schema === POPUPS_SCHEMA_ID) return validatePopupsSource(source, file)
  if (schema === TESTCASE_SCHEMA_ID || parsed.errors.length > 0) {
    return validateTestCaseSource(source, file)
  }
  return {
    valid: false,
    errors: [
      {
        file,
        path: 'schema',
        code: 'schema',
        message: `unknown schema ${JSON.stringify(schema)}; expected one of ${DOCUMENT_SCHEMAS.join(', ')}`,
        ...(parsed.positionOf(['schema']) ?? {}),
      },
    ],
    warnings: [],
  }
}
