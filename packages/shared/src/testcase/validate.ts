import type { z } from 'zod'
import type { Platform } from '../element'
import { formatPath } from '../path'
import { isPermission } from '../permissions'
import { parseYaml, type ParsedYaml } from './parse'
import {
  imageLocator,
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
  'image_path_invalid',
  'image_in_expect',
  'image_not_found',
  // expect.screen names a screen the app map does not have (Phase 3, D24)
  'unknown_screen',
  // brains.yaml (Phase 3, contracts/brains-yaml.md)
  'unknown_provider',
  'provider_disabled',
  'vision_required',
  'price_missing',
  'invalid_limit',
  // mcp.yaml (§14.5)
  'stdio_not_allowed',
] as const
export const VALIDATION_WARNING_CODES = ['no_expect_after_tap', 'inline_credential'] as const
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

export interface TestCaseCheckOptions {
  /**
   * Whether a path of the project repo exists (the server: the repo at that commit; the CLI: its
   * project root). Without it, `image_not_found` is not checked.
   */
  fileExists?: (path: string) => boolean
  /**
   * Whether the app map (`appmap/screens.json`) has a screen of that id. Without it,
   * `unknown_screen` is not checked.
   */
  screenExists?: (id: string) => boolean
}

/** Validates YAML source text; errors carry line/column. */
export function validateTestCaseSource(
  source: string,
  file: string,
  options: TestCaseCheckOptions = {},
): ValidationResult<TestCase> {
  return validateParsed(parseYaml(source), file, (value) => checkTestCase(value, options))
}

/** Validates an already-parsed value (no positions). */
export function validateTestCase(
  value: unknown,
  file = '<input>',
  options: TestCaseCheckOptions = {},
): ValidationResult<TestCase> {
  return finish(file, value, undefined, checkTestCase(value, options))
}

/** A repo path an `image` locator may use: relative, no `..`, no backslash, a `.png` file. */
export function isValidImagePath(path: string): boolean {
  return (
    !path.startsWith('/') &&
    !/^[A-Za-z]:/.test(path) &&
    !path.includes('\\') &&
    !path.split('/').some((segment) => segment === '..' || segment === '') &&
    /\.png$/i.test(path)
  )
}

/** The app map screens `expect.screen` names, with the first step naming each (D24). */
export function referencedScreens(testCase: TestCase): { id: string; stepId: string }[] {
  const found = new Map<string, string>()
  testCase.steps.forEach((step, i) => {
    for (const [condition] of conditions(step, ['steps', i])) {
      if (condition.screen !== undefined && !found.has(condition.screen)) {
        found.set(condition.screen, step.id)
      }
    }
  })
  return [...found].map(([id, stepId]) => ({ id, stepId }))
}

/** Paths of every image an `image` locator of the test case refers to (sorted, unique). */
export function imagePaths(testCase: TestCase): string[] {
  const paths = new Set<string>()
  testCase.steps.forEach((step, i) => {
    for (const [list, path] of locatorLists(step, ['steps', i])) {
      list.forEach((locator, j) =>
        walkLocator(locator, [...path, j], (inner) => {
          if (inner.image !== undefined) paths.add(imageLocator(inner.image).path)
        }),
      )
    }
  })
  return [...paths].sort()
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

function checkTestCase(value: unknown, options: TestCaseCheckOptions): CheckOutcome<TestCase> {
  const parsed = testCaseSchema.safeParse(value)
  if (!parsed.success) return { issues: schemaIssues(parsed.error) }
  const tc = parsed.data
  return { value: tc, issues: semanticIssues(tc, options) }
}

function semanticIssues(tc: TestCase, options: TestCaseCheckOptions): RawIssue[] {
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
          if (inner.image === undefined) return
          const imagePath = imageLocator(inner.image).path
          const at = [...innerPath, 'image']
          if (path.includes('expect') || path.includes('until')) {
            issues.push({
              path: at,
              code: 'image_in_expect',
              message:
                'image locators only find tap/type targets (Phase 2); use text or ids in expect',
            })
          } else if (!isValidImagePath(imagePath)) {
            issues.push({
              path: at,
              code: 'image_path_invalid',
              message: `"${imagePath}" must be a .png path inside the project repo (no "..", not absolute)`,
            })
          } else if (options.fileExists && !options.fileExists(imagePath)) {
            issues.push({
              path: at,
              code: 'image_not_found',
              message: `"${imagePath}" is not in the project repo`,
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
      if (condition.screen !== undefined && options.screenExists?.(condition.screen) === false) {
        issues.push({
          path: [...path, 'screen'],
          code: 'unknown_screen',
          message: `screen "${condition.screen}" is not in the app map (appmap/screens.json)`,
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
