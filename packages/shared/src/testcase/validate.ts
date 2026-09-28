import type { z } from 'zod'
import type { Platform } from '../element'
import { formatPath } from '../path'
import { isPermission } from '../permissions'
import { parseYaml, type ParsedYaml } from './parse'
import {
  testCaseSchema,
  type ExpectCondition,
  type Locator,
  type Step,
  type TestCase,
} from './schema'

/** Error codes of contracts/testcase-format.md (+ `yaml` for unparsable files). */
export const VALIDATION_ERROR_CODES = [
  'yaml',
  'schema',
  'var_undeclared',
  'unknown_permission',
  'platform_coverage',
  'duplicate_step_id',
  'unsupported_in_phase',
  'point_pct_not_last',
  'duplicate_rule_name',
  'rule_taps_never_tap',
] as const
export const VALIDATION_WARNING_CODES = ['no_expect_after_tap'] as const
export type ValidationCode =
  (typeof VALIDATION_ERROR_CODES)[number] | (typeof VALIDATION_WARNING_CODES)[number]

/** Wire format of one problem (snake_case, D12). */
export interface ValidationIssue {
  file: string
  step_id?: string
  path: string
  code: ValidationCode
  message: string
  line?: number
  column?: number
}

export interface ValidationResult<T> {
  valid: boolean
  /** The parsed document when it passed the schema (even if semantic errors remain). */
  value?: T
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}

type Path = (string | number)[]
interface RawIssue {
  path: Path
  code: ValidationCode
  message: string
}

const INTERPOLATION = /\$\{(secret|var):([^}]*)\}/g

/** Validates YAML source text; errors carry line/column. */
export function validateTestCaseSource(source: string, file: string): ValidationResult<TestCase> {
  return validateParsed(parseYaml(source), file, checkTestCase)
}

/** Validates an already-parsed value (no positions). */
export function validateTestCase(value: unknown, file = '<input>'): ValidationResult<TestCase> {
  return finish(file, value, undefined, checkTestCase(value))
}

// --- shared plumbing (also used by popups) --------------------------------------------------

export interface CheckOutcome<T> {
  value?: T
  issues: RawIssue[]
}

export function validateParsed<T>(
  parsed: ParsedYaml,
  file: string,
  check: (value: unknown) => CheckOutcome<T>,
): ValidationResult<T> {
  if (parsed.errors.length > 0) {
    return {
      valid: false,
      errors: parsed.errors.map((e) => ({
        file,
        path: '',
        code: 'yaml',
        message: e.message,
        line: e.line,
        column: e.column,
      })),
      warnings: [],
    }
  }
  return finish(file, parsed.value, parsed, check(parsed.value))
}

function finish<T>(
  file: string,
  raw: unknown,
  parsed: ParsedYaml | undefined,
  outcome: CheckOutcome<T>,
): ValidationResult<T> {
  const toIssue = (issue: RawIssue): ValidationIssue => {
    const stepId = stepIdAt(raw, issue.path)
    const position = parsed?.positionOf(issue.path)
    return {
      file,
      ...(stepId === undefined ? {} : { step_id: stepId }),
      path: formatPath(issue.path),
      code: issue.code,
      message: issue.message,
      ...(position ?? {}),
    }
  }
  const isWarning = (code: ValidationCode) =>
    (VALIDATION_WARNING_CODES as readonly string[]).includes(code)
  const errors = outcome.issues.filter((i) => !isWarning(i.code)).map(toIssue)
  const warnings = outcome.issues.filter((i) => isWarning(i.code)).map(toIssue)
  return {
    valid: errors.length === 0,
    ...(outcome.value === undefined ? {} : { value: outcome.value }),
    errors,
    warnings,
  }
}

function stepIdAt(raw: unknown, path: Path): string | undefined {
  if (path[0] !== 'steps' || typeof path[1] !== 'number') return undefined
  const steps = (raw as { steps?: unknown } | null)?.steps
  if (!Array.isArray(steps)) return undefined
  const id = (steps[path[1]] as { id?: unknown } | undefined)?.id
  return typeof id === 'string' ? id : undefined
}

export function schemaIssues(error: z.ZodError): RawIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.filter((p): p is string | number => typeof p !== 'symbol'),
    code: 'schema' as const,
    message: issue.message,
  }))
}

// --- test case rules ------------------------------------------------------------------------

function checkTestCase(value: unknown): CheckOutcome<TestCase> {
  const parsed = testCaseSchema.safeParse(value)
  if (!parsed.success) return { issues: schemaIssues(parsed.error) }
  const tc = parsed.data
  return { value: tc, issues: semanticIssues(tc) }
}

function semanticIssues(tc: TestCase): RawIssue[] {
  const issues: RawIssue[] = []
  const declared = new Set(Object.keys(tc.variables ?? {}))

  tc.preconditions?.grant_permissions?.forEach((permission, i) => {
    if (!isPermission(permission)) {
      issues.push({
        path: ['preconditions', 'grant_permissions', i],
        code: 'unknown_permission',
        message: `unknown permission "${permission}" (SPEC §7.5)`,
      })
    }
  })

  const seen = new Set<string>()
  tc.steps.forEach((step, i) => {
    const at: Path = ['steps', i]
    if (seen.has(step.id)) {
      issues.push({
        path: [...at, 'id'],
        code: 'duplicate_step_id',
        message: `step id "${step.id}" is already used`,
      })
    }
    seen.add(step.id)

    walkStrings(step, at, (text, path) => {
      for (const match of text.matchAll(INTERPOLATION)) {
        const [, kind, name = ''] = match
        if (kind === 'var' && !declared.has(name)) {
          issues.push({
            path,
            code: 'var_undeclared',
            message: `\${var:${name}} is not declared in variables`,
          })
        }
      }
    })

    for (const [list, path] of locatorLists(step, at)) {
      checkCoverage(list, path, tc.platforms, issues)
      list.forEach((locator, j) => {
        walkLocator(locator, [...path, j], (inner, innerPath) => {
          if (inner.image !== undefined) {
            issues.push({
              path: innerPath,
              code: 'unsupported_in_phase',
              message: 'image locators are not supported yet (Phase 2, D27)',
            })
          }
        })
      })
    }

    if ('target' in step && step.target) {
      const last = step.target.length - 1
      step.target.forEach((locator, j) => {
        if (locator.point_pct !== undefined && j !== last) {
          issues.push({
            path: [...at, 'target', j],
            code: 'point_pct_not_last',
            message: 'point_pct is the last resort and must be the last locator (P2)',
          })
        }
      })
    }

    for (const [condition, path] of conditions(step, at)) {
      if (condition.screen !== undefined) {
        issues.push({
          path: [...path, 'screen'],
          code: 'unsupported_in_phase',
          message: 'expect.screen needs the app map (Phase 3)',
        })
      }
    }

    if (step.action === 'tap' && !step.expect && tc.steps[i + 1]?.action !== 'assert') {
      issues.push({
        path: at,
        code: 'no_expect_after_tap',
        message: 'tap has no expect and the next step is not an assert',
      })
    }
  })
  return issues
}

function walkStrings(value: unknown, path: Path, visit: (text: string, path: Path) => void): void {
  if (typeof value === 'string') visit(value, path)
  else if (Array.isArray(value)) value.forEach((item, i) => walkStrings(item, [...path, i], visit))
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) walkStrings(item, [...path, key], visit)
  }
}

function walkLocator(
  locator: Locator,
  path: Path,
  visit: (locator: Locator, path: Path) => void,
): void {
  visit(locator, path)
  if (locator.rel) {
    for (const key of ['below', 'above', 'left_of', 'right_of'] as const) {
      const inner = locator.rel[key]
      if (inner) walkLocator(inner, [...path, 'rel', key], visit)
    }
  }
  const within = locator.class_index?.within
  if (within) walkLocator(within, [...path, 'class_index', 'within'], visit)
}

function conditions(step: Step, at: Path): [ExpectCondition, Path][] {
  const found: [ExpectCondition, Path][] = []
  step.expect?.forEach((c, j) => found.push([c, [...at, 'expect', j]]))
  if (step.action === 'wait') step.until?.forEach((c, j) => found.push([c, [...at, 'until', j]]))
  return found
}

/** Every locator chain in a step: target, and visible/not_visible of its conditions. */
function locatorLists(step: Step, at: Path): [Locator[], Path][] {
  const lists: [Locator[], Path][] = []
  if ('target' in step && step.target) lists.push([step.target, [...at, 'target']])
  for (const [condition, path] of conditions(step, at)) {
    for (const key of ['visible', 'not_visible'] as const) {
      const value = condition[key]
      if (value) lists.push([Array.isArray(value) ? value : [value], [...path, key]])
    }
  }
  return lists
}

const ALL_PLATFORMS: readonly Platform[] = ['android', 'ios']

/** Platforms on which a locator can resolve (D14). */
export function locatorPlatforms(locator: Locator): readonly Platform[] {
  if (locator.android_id !== undefined) return ['android']
  if (locator.ios_id !== undefined) return ['ios']
  if (locator.rel) {
    const anchor =
      locator.rel.below ?? locator.rel.above ?? locator.rel.left_of ?? locator.rel.right_of
    return anchor ? locatorPlatforms(anchor) : ALL_PLATFORMS
  }
  const within = locator.class_index?.within
  if (within) return locatorPlatforms(within)
  return ALL_PLATFORMS
}

function checkCoverage(
  list: Locator[],
  path: Path,
  platforms: readonly Platform[],
  issues: RawIssue[],
): void {
  const covered = new Set(list.flatMap((locator) => locatorPlatforms(locator)))
  const missing = platforms.filter((p) => !covered.has(p))
  if (missing.length > 0) {
    issues.push({
      path,
      code: 'platform_coverage',
      message: `no locator usable on ${missing.join(', ')}`,
    })
  }
}
