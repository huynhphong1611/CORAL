import { z } from 'zod'
import { parseYaml } from '../testcase/parse'
import {
  schemaIssues,
  validateParsed,
  type CheckOutcome,
  type ValidationResult,
} from '../testcase/validate'

/** `coral/popups@1` (SPEC §9.2, contracts/testcase-format.md). */
export const POPUPS_SCHEMA_ID = 'coral/popups@1'

const nonEmpty = z.string().trim().min(1)
const MATCH_KEYS = ['package', 'alert_contains', 'text_contains', 'resource_id'] as const

export const popupMatchSchema = z
  .strictObject({
    package: nonEmpty.optional(),
    alert_contains: nonEmpty.optional(),
    text_contains: nonEmpty.optional(),
    resource_id: nonEmpty.optional(),
  })
  .refine((m) => MATCH_KEYS.some((key) => m[key] !== undefined), {
    message: `match needs at least one of: ${MATCH_KEYS.join(', ')}`,
  })

export const popupRuleSchema = z.strictObject({
  name: nonEmpty,
  match: popupMatchSchema,
  tap_any: z.array(nonEmpty).min(1),
})
export type PopupRule = z.infer<typeof popupRuleSchema>

export const popupsSchema = z.strictObject({
  schema: z.literal(POPUPS_SCHEMA_ID),
  rules: z.array(popupRuleSchema).default([]),
  never_tap: z.array(nonEmpty).default([]),
})
export type Popups = z.infer<typeof popupsSchema>

/** Button text comparison: case-insensitive, whole string, whitespace collapsed (SPEC §9.4). */
export function normalizeButtonText(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

function checkPopups(value: unknown): CheckOutcome<Popups> {
  const parsed = popupsSchema.safeParse(value)
  if (!parsed.success) return { issues: schemaIssues(parsed.error) }
  const popups = parsed.data
  const issues: CheckOutcome<Popups>['issues'] = []
  const forbidden = new Set(popups.never_tap.map(normalizeButtonText))
  const names = new Set<string>()
  popups.rules.forEach((rule, i) => {
    if (names.has(rule.name)) {
      issues.push({
        path: ['rules', i, 'name'],
        code: 'duplicate_rule_name',
        message: `rule name "${rule.name}" is already used`,
      })
    }
    names.add(rule.name)
    rule.tap_any.forEach((button, j) => {
      if (forbidden.has(normalizeButtonText(button))) {
        issues.push({
          path: ['rules', i, 'tap_any', j],
          code: 'rule_taps_never_tap',
          message: `"${button}" is in never_tap and may only be tapped by a human-written step (P6)`,
        })
      }
    })
  })
  return { value: popups, issues }
}

export function validatePopupsSource(source: string, file: string): ValidationResult<Popups> {
  return validateParsed(parseYaml(source), file, checkPopups)
}
