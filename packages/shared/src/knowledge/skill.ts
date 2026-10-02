import { parse } from 'yaml'
import { z } from 'zod'
import { parseYaml } from '../testcase/parse'
import { locatorSchema, type Locator } from '../testcase/schema'
import {
  schemaIssues,
  validateParsed,
  type CheckOutcome,
  type ValidationIssue,
  type ValidationResult,
} from '../testcase/validate'
import { normalizeButtonText } from '../popups/schema'

/**
 * Project knowledge for the AI roles (SPEC §13, D42, contracts/project-knowledge.md):
 * `skills/<name>/SKILL.md` follows the Agent Skills standard (frontmatter name + description);
 * the machine-read rules of a skill sit next to it in `rules.yaml` (`coral/skill-rules@1`).
 */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
export const MAX_SKILL_DESCRIPTION = 300
export const MAX_AGENTS_MD_BYTES = 64 * 1024
export const SKILL_RULES_SCHEMA_ID = 'coral/skill-rules@1'

export interface Skill {
  name: string
  description: string
  /** The Markdown after the frontmatter. */
  body: string
}

const frontmatterSchema = z.looseObject({
  name: z
    .string()
    .regex(SKILL_NAME_PATTERN, 'name: [a-z0-9-], at most 64, starting with a letter or digit'),
  description: z.string().trim().min(1).max(MAX_SKILL_DESCRIPTION),
})

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

/**
 * Reads a SKILL.md: its frontmatter must have `name` (equal to `expectedName`, the folder) and
 * `description`. Problems carry the line in the whole file.
 */
export function validateSkillSource(
  source: string,
  expectedName?: string,
  file = 'SKILL.md',
): ValidationResult<Skill> {
  const match = FRONTMATTER.exec(source)
  if (!match) {
    return {
      valid: false,
      errors: [
        {
          file,
          path: '',
          code: 'schema',
          message: 'SKILL.md starts with a frontmatter block between --- lines (name, description)',
          line: 1,
          column: 1,
        },
      ],
      warnings: [],
    }
  }
  const [, front = '', body = ''] = match
  const result = validateParsed(parseYaml(front), file, (value): CheckOutcome<Skill> => {
    const parsed = frontmatterSchema.safeParse(value)
    if (!parsed.success) return { issues: schemaIssues(parsed.error) }
    const issues: CheckOutcome<Skill>['issues'] = []
    if (expectedName !== undefined && parsed.data.name !== expectedName) {
      issues.push({
        path: ['name'],
        code: 'schema',
        message: `name must be the folder name "${expectedName}"`,
      })
    }
    return {
      value: { name: parsed.data.name, description: parsed.data.description, body },
      issues,
    }
  })
  // Lines are counted from the first `---` of the file.
  const shift = (issue: ValidationIssue): ValidationIssue =>
    issue.line === undefined ? issue : { ...issue, line: issue.line + 1 }
  return { ...result, errors: result.errors.map(shift), warnings: result.warnings.map(shift) }
}

/** Name and description of a SKILL.md without full checking (for listings); undefined if unreadable. */
export function skillHeader(source: string): Pick<Skill, 'name' | 'description'> | undefined {
  const match = FRONTMATTER.exec(source)
  if (!match) return undefined
  try {
    const parsed = frontmatterSchema.safeParse(parse(match[1] ?? ''))
    return parsed.success
      ? { name: parsed.data.name, description: parsed.data.description }
      : undefined
  } catch {
    return undefined
  }
}

// --- rules.yaml ------------------------------------------------------------------------------

const nonEmpty = z.string().trim().min(1)
const dataName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'a name: [A-Za-z_][A-Za-z0-9_]*')

/** A forbidden element: a structured locator (no image, no point — they say nothing stable). */
const forbiddenLocatorSchema = locatorSchema.refine(
  (l) => l.image === undefined && l.point_pct === undefined,
  'forbidden takes id, text, desc, rel or class_index locators',
)

export const skillRulesSchema = z.strictObject({
  schema: z.literal(SKILL_RULES_SCHEMA_ID),
  never_tap: z.array(nonEmpty).default([]),
  forbidden: z.array(forbiddenLocatorSchema).default([]),
  test_data: z.record(dataName, z.string().max(200)).default({}),
  allow_submit: z.array(z.strictObject({ screen_text: nonEmpty })).default([]),
})
export type SkillRules = z.infer<typeof skillRulesSchema>

export function validateSkillRulesSource(
  source: string,
  file = 'rules.yaml',
): ValidationResult<SkillRules> {
  return validateParsed(parseYaml(source), file, (value): CheckOutcome<SkillRules> => {
    const parsed = skillRulesSchema.safeParse(value)
    return parsed.success
      ? { value: parsed.data, issues: [] }
      : { issues: schemaIssues(parsed.error) }
  })
}

/** The rules of every skill of a project, as one (D42): applied to every exploration. */
export interface ProjectRules {
  neverTap: string[]
  forbidden: Locator[]
  /** Name → value as written (`${secret:NAME}` stays a reference). */
  testData: Record<string, string>
  allowSubmit: { screen_text: string }[]
}

export function mergeRules(rules: readonly SkillRules[]): ProjectRules {
  const neverTap = new Map<string, string>()
  const merged: ProjectRules = { neverTap: [], forbidden: [], testData: {}, allowSubmit: [] }
  for (const r of rules) {
    for (const text of r.never_tap) neverTap.set(normalizeButtonText(text), text)
    merged.forbidden.push(...r.forbidden)
    Object.assign(merged.testData, r.test_data)
    merged.allowSubmit.push(...r.allow_submit)
  }
  merged.neverTap = [...neverTap.values()]
  return merged
}
