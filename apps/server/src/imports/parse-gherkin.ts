import {
  MANUALCASE_SCHEMA_ID,
  MAX_IMPORT_CASES,
  MAX_MANUAL_TITLE,
  manualCaseSchema,
  type api,
  type ManualCase,
  type ManualStep,
} from '@coral/shared'
import {
  AstBuilder,
  compile,
  dialects,
  Errors,
  GherkinClassicTokenMatcher,
  Parser,
} from '@cucumber/gherkin'
import {
  PickleStepType,
  type FeatureChild,
  type GherkinDocument,
  type Pickle,
  type RuleChild,
  type PickleStep,
  type Scenario,
  type TableRow,
} from '@cucumber/messages'
import type { TableRead } from './mapping'

const MAX_TAG = 100

/** A counter for the ids the Gherkin AST and its pickles need. */
function idGenerator() {
  let n = 0
  return () => String((n += 1))
}

type Parsed = { document: GherkinDocument; errors: [] } | { errors: api.ImportIssue[] }

function parseDocument(text: string): Parsed {
  const newId = idGenerator()
  const parser = new Parser(new AstBuilder(newId), new GherkinClassicTokenMatcher())
  parser.stopAtFirstError = false
  try {
    return { document: parser.parse(text), errors: [] }
  } catch (error) {
    if (!(error instanceof Errors.GherkinException)) throw error
    const all = error instanceof Errors.CompositeParserException ? error.errors : [error]
    return {
      errors: all.map((e) => {
        const line = (e as Errors.GherkinException).location?.line
        return { ...(line ? { line } : {}), code: 'syntax', message: e.message }
      }),
    }
  }
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The file with only the lines before the first scenario and those of one scenario, the others
 * blank (their lines keep their numbers): what a syntax error leaves of each scenario.
 */
function scenarioChunks(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const language = /^\s*#\s*language\s*:\s*(\S+)/m.exec(lines.slice(0, 5).join('\n'))?.[1]
  const dialect = dialects[language ?? 'en'] ?? dialects.en
  const keywords = [...(dialect?.scenario ?? []), ...(dialect?.scenarioOutline ?? [])]
  const start = new RegExp(`^\\s*(${keywords.map((k) => escape(k.trim())).join('|')})\\s*:`)
  const starts: number[] = []
  lines.forEach((line, i) => {
    if (!start.test(line)) return
    let first = i
    while (first > 0 && /^\s*@/.test(lines[first - 1] ?? '')) first -= 1
    starts.push(first)
  })
  const preamble = starts[0] ?? lines.length
  return starts.map((from, k) => {
    const to = starts[k + 1] ?? lines.length
    return lines.map((line, i) => (i < preamble || (i >= from && i < to) ? line : '')).join('\n')
  })
}

/** What the AST says of the pickles' sources: scenarios, example rows, background steps. */
type Sources = ReturnType<typeof sources>
function sources(document: GherkinDocument) {
  const scenarios = new Map<string, Scenario>()
  const rows = new Map<string, TableRow>()
  const background = new Set<string>()
  const visit = (children: readonly (FeatureChild | RuleChild)[]) => {
    for (const child of children) {
      if (child.background) for (const step of child.background.steps) background.add(step.id)
      if (child.scenario) {
        scenarios.set(child.scenario.id, child.scenario)
        for (const examples of child.scenario.examples) {
          for (const row of examples.tableBody) rows.set(row.id, row)
        }
      }
      if ('rule' in child && child.rule) visit(child.rule.children)
    }
  }
  if (document.feature) visit(document.feature.children)
  return { scenarios, rows, background }
}

/** A step's text, with its doc string or data table. */
function stepText(step: PickleStep): string {
  const { docString, dataTable } = step.argument ?? {}
  const extra = docString
    ? docString.content
    : dataTable
      ? dataTable.rows.map((r) => `| ${r.cells.map((c) => c.value).join(' | ')} |`).join('\n')
      : ''
  return extra ? `${step.text}\n${extra}` : step.text
}

interface Draft {
  line: number
  title: string
  preconditions: string[]
  steps: ManualStep[]
  tags: string[]
}

/**
 * One scenario run (an example row of an outline is one): `Given` and the Background are
 * preconditions, `When` a step, `Then` the expected result of the step before it.
 */
function draftOf(pickle: Pickle, featureName: string, from: Sources): Draft | undefined {
  const { scenarios, rows, background } = from
  const scenario = scenarios.get(pickle.astNodeIds[0] ?? '')
  if (!scenario) return undefined
  const row = pickle.astNodeIds[1] ? rows.get(pickle.astNodeIds[1]) : undefined
  const first = row?.cells[0]?.value
  const preconditions: string[] = []
  const steps: ManualStep[] = []
  const early: string[] = []
  for (const step of pickle.steps) {
    const text = stepText(step)
    const fromBackground = step.astNodeIds.some((id) => background.has(id))
    if (fromBackground || step.type === PickleStepType.CONTEXT) preconditions.push(text)
    else if (step.type === PickleStepType.OUTCOME) {
      const last = steps[steps.length - 1]
      if (!last) early.push(text)
      else last.expected = last.expected ? `${last.expected}\n${text}` : text
    } else steps.push({ action: text })
  }
  // A Then before any When: what the first step should show.
  const head = steps[0]
  if (head && early.length > 0) {
    head.expected = [...early, ...(head.expected ? [head.expected] : [])].join('\n')
  }
  const tags = [featureName, ...pickle.tags.map((t) => t.name.replace(/^@/, ''))]
    .map((t) => t.trim().slice(0, MAX_TAG))
    .filter((t, i, all) => t !== '' && all.indexOf(t) === i)
  return {
    line: row?.location.line ?? scenario.location.line,
    title: first !== undefined ? `${pickle.name} (${first})` : pickle.name,
    preconditions,
    steps,
    tags,
  }
}

function draftsOf(document: GherkinDocument, file: string): Draft[] {
  const from = sources(document)
  const featureName = document.feature?.name ?? ''
  return compile(document, file, idGenerator()).flatMap(
    (pickle) => draftOf(pickle, featureName, from) ?? [],
  )
}

/**
 * A Gherkin `.feature` file as manual cases (contracts/manualcase.md): one per scenario, one
 * per example row of an outline (its title ends with the row's first value). A syntax error is
 * reported at its line; the scenarios without one are still read.
 */
export function parseGherkin(file: string, bytes: Uint8Array): TableRead {
  const text = new TextDecoder('utf-8').decode(bytes)
  const parsed = parseDocument(text)
  const errors: api.ImportIssue[] = [...parsed.errors]
  let drafts: Draft[]
  if ('document' in parsed) drafts = draftsOf(parsed.document, file)
  else {
    drafts = scenarioChunks(text).flatMap((chunk) => {
      const one = parseDocument(chunk)
      return 'document' in one ? draftsOf(one.document, file) : []
    })
  }
  const cases: ManualCase[] = []
  for (const draft of drafts.sort((a, b) => a.line - b.line)) {
    const at = { line: draft.line }
    if (draft.title.length > MAX_MANUAL_TITLE) {
      errors.push({
        ...at,
        code: 'too_long',
        message: `the title is longer than ${MAX_MANUAL_TITLE}`,
      })
      continue
    }
    if (draft.steps.length === 0) {
      errors.push({ ...at, code: 'missing_steps', message: `"${draft.title}" has no When step` })
      continue
    }
    if (cases.length >= MAX_IMPORT_CASES) {
      errors.push({
        ...at,
        code: 'too_many_cases',
        message: `only the first ${MAX_IMPORT_CASES} test cases are read`,
      })
      break
    }
    const result = manualCaseSchema.safeParse({
      schema: MANUALCASE_SCHEMA_ID,
      id: String(cases.length + 1).padStart(3, '0'),
      title: draft.title,
      preconditions: draft.preconditions,
      steps: draft.steps,
      tags: draft.tags,
      source: { file, line: draft.line },
    })
    if (result.success) cases.push(result.data)
    else {
      errors.push({
        ...at,
        code: 'too_long',
        message: result.error.issues[0]?.message ?? 'not a valid test case',
      })
    }
  }
  return {
    columns: [],
    mapping: null,
    cases,
    errors: errors.sort((a, b) => (a.line ?? 0) - (b.line ?? 0)),
  }
}
