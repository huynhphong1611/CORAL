import {
  MANUALCASE_SCHEMA_ID,
  MAX_IMPORT_CASES,
  MAX_MANUAL_TEXT,
  MAX_MANUAL_TITLE,
  manualCaseSchema,
  type api,
  type ImportMapping,
  type ManualCase,
  type ManualStep,
} from '@coral/shared'

/**
 * From the rows of a spreadsheet (CSV, XLSX) to manual cases (contracts/manualcase.md): which
 * column holds what — guessed from the header, or chosen — then one case per titled row, the
 * rows below without a title adding steps to it, numbered lines of a cell split into steps.
 * A row in error is left out and reported; the rest of the file is still read.
 */

/** Cells of one row, as text; row `i` of the array is row `i + 1` of the file. */
export type Rows = readonly (readonly string[])[]

export interface TableRead {
  columns: { index: number; header: string }[]
  mapping: ImportMapping | null
  cases: ManualCase[]
  errors: api.ImportIssue[]
}

/** Lowercase ASCII words of a header: `Kết quả mong đợi` → `ket qua mong doi`. */
export function normalizeHeader(header: string): string {
  return header
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

const NAMES: Record<'id' | 'title' | 'preconditions' | 'steps' | 'expected', string[]> = {
  id: ['id', 'test id', 'case id', 'test case id', 'tc id', 'ma', 'ma test case'],
  title: [
    'title',
    'name',
    'summary',
    'test case',
    'test case name',
    'tieu de',
    'ten',
    'ten test case',
  ],
  preconditions: ['precondition', 'preconditions', 'pre condition', 'tien dieu kien'],
  steps: ['step', 'steps', 'test steps', 'action', 'actions', 'buoc', 'cac buoc', 'thao tac'],
  expected: [
    'expected',
    'expected result',
    'expected results',
    'ket qua',
    'ket qua mong doi',
    'ket qua mong muon',
  ],
}
/** `Step 1`, `Bước 2`, `Expected 1`: one column per step. */
const NUMBERED_STEP = /^(step|buoc|action|thao tac) ?\d+$/
const NUMBERED_EXPECTED = /^(expected|expected result|ket qua) ?\d+$/

/**
 * Which column holds what, from the header row; null when no column can be told to hold the
 * titles or the steps.
 */
export function guessMapping(header: readonly string[], headerRow = 0): ImportMapping | null {
  const names = header.map(normalizeHeader)
  const find = (field: keyof typeof NAMES) => {
    const index = names.findIndex((name) => NAMES[field].includes(name))
    return index >= 0 ? index : undefined
  }
  const all = (field: 'steps' | 'expected', numbered: RegExp) =>
    names.flatMap((name, i) => (NAMES[field].includes(name) || numbered.test(name) ? [i] : []))
  const title = find('title')
  const steps = all('steps', NUMBERED_STEP)
  if (title === undefined || steps.length === 0) return null
  const id = find('id')
  const preconditions = find('preconditions')
  return {
    title,
    steps,
    expected: all('expected', NUMBERED_EXPECTED),
    ...(id !== undefined ? { id } : {}),
    ...(preconditions !== undefined ? { preconditions } : {}),
    header_row: headerRow,
  }
}

const NUMBERED = /^(?:(\d+)\s*[.):]|[-•*])\s+(.*)$/

/**
 * The items of a cell: each numbered (`1.`, `2)`) or bulleted (`- `) line starts one, the lines
 * after it continue it; a cell with no such line is one item.
 */
export function splitItems(cell: string): { n?: number; text: string }[] {
  const lines = cell
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (!lines.some((l) => NUMBERED.test(l))) {
    const text = lines.join('\n')
    return text ? [{ text }] : []
  }
  const items: { n?: number; text: string }[] = []
  for (const line of lines) {
    const match = NUMBERED.exec(line)
    const last = items[items.length - 1]
    if (match) {
      const n = match[1] ? Number(match[1]) : undefined
      items.push({ ...(n !== undefined ? { n } : {}), text: match[2] ?? '' })
    } else if (last) last.text = `${last.text}\n${line}`
    else items.push({ text: line })
  }
  return items.filter((i) => i.text !== '')
}

/**
 * The steps of one row: the actions of each step column, each with its expected result — by the
 * same number, else in order when there are as many, else the whole expected cell on the last.
 */
function stepsOf(cells: readonly string[], mapping: ImportMapping): ManualStep[] {
  const paired = mapping.expected.length === mapping.steps.length
  const last = mapping.steps.length - 1
  return mapping.steps.flatMap((column, k) => {
    const actions = splitItems(cells[column] ?? '')
    // One expected column per step column, else the expected column goes with the last one.
    const expectedColumn = paired
      ? mapping.expected[k]
      : k === last
        ? mapping.expected[0]
        : undefined
    const expected = expectedColumn !== undefined ? splitItems(cells[expectedColumn] ?? '') : []
    const numbered = expected.length > 0 && expected.every((e) => e.n !== undefined)
    return actions.map((action, i): ManualStep => {
      const text = numbered
        ? expected.find((e) => e.n === (action.n ?? i + 1))?.text
        : expected.length === actions.length
          ? expected[i]?.text
          : i === actions.length - 1 && expected.length > 0
            ? expected.map((e) => e.text).join('\n')
            : undefined
      return { action: action.text, ...(text ? { expected: text } : {}) }
    })
  })
}

interface Draft {
  row: number
  id?: string
  title: string
  preconditions: string[]
  steps: ManualStep[]
  /** A row of this case was in error: the case is left out. */
  broken: boolean
}

/** Reads the rows under a mapping (or the one guessed from the header row when none). */
export function readTable(file: string, rows: Rows, chosen?: ImportMapping | null): TableRead {
  const headerRow = chosen?.header_row ?? 0
  const header = rows[headerRow] ?? []
  const columns = header.map((h, index) => ({ index, header: h.trim() }))
  const mapping = chosen ?? guessMapping(header, headerRow)
  const errors: api.ImportIssue[] = []
  if (!mapping) {
    errors.push({
      code: 'no_mapping',
      message: 'cannot tell which columns hold the titles and the steps: choose them',
    })
    return { columns, mapping: null, cases: [], errors }
  }
  const mapped = [
    mapping.title,
    ...mapping.steps,
    ...mapping.expected,
    ...(mapping.id !== undefined ? [mapping.id] : []),
    ...(mapping.preconditions !== undefined ? [mapping.preconditions] : []),
  ]
  const drafts: Draft[] = []
  let current: Draft | undefined
  for (let i = headerRow + 1; i < rows.length; i += 1) {
    const cells = (rows[i] ?? []).map((c) => c.trim())
    const row = i + 1
    if (mapped.every((c) => !cells[c])) continue
    const title = cells[mapping.title] ?? ''
    const problem = mapped
      .map((c) => cells[c] ?? '')
      .find((c) => c.length > MAX_MANUAL_TEXT || c.includes('�'))
    if (problem !== undefined) {
      errors.push(
        problem.includes('�')
          ? { row, code: 'bad_encoding', message: 'the row is not UTF-8 text' }
          : {
              row,
              code: 'too_long',
              message: `a cell is longer than ${MAX_MANUAL_TEXT} characters`,
            },
      )
      // A titled row in error takes the rows below it with it.
      if (title) {
        current = { row, title, preconditions: [], steps: [], broken: true }
        drafts.push(current)
      } else if (current) current.broken = true
      continue
    }
    const steps = stepsOf(cells, mapping)
    const preconditions =
      mapping.preconditions !== undefined
        ? splitItems(cells[mapping.preconditions] ?? '').map((p) => p.text)
        : []
    if (title) {
      current = {
        row,
        ...(mapping.id !== undefined && cells[mapping.id] ? { id: cells[mapping.id] } : {}),
        title,
        preconditions,
        steps,
        broken: false,
      }
      drafts.push(current)
    } else if (current) {
      current.preconditions.push(...preconditions)
      current.steps.push(...steps)
    } else {
      errors.push({ row, code: 'missing_title', message: 'a step with no test case above it' })
    }
  }

  const cases: ManualCase[] = []
  for (const draft of drafts) {
    if (draft.broken) continue
    if (draft.title.length > MAX_MANUAL_TITLE) {
      errors.push({
        row: draft.row,
        code: 'too_long',
        message: `the title is longer than ${MAX_MANUAL_TITLE} characters`,
      })
      continue
    }
    if (draft.steps.length === 0) {
      errors.push({
        row: draft.row,
        code: 'missing_steps',
        message: `"${draft.title}" has no step`,
      })
      continue
    }
    if (cases.length >= MAX_IMPORT_CASES) {
      errors.push({
        row: draft.row,
        code: 'too_many_cases',
        message: `only the first ${MAX_IMPORT_CASES} test cases are read`,
      })
      break
    }
    const parsed = manualCaseSchema.safeParse({
      schema: MANUALCASE_SCHEMA_ID,
      id: draft.id ?? String(cases.length + 1).padStart(3, '0'),
      title: draft.title,
      preconditions: draft.preconditions,
      steps: draft.steps,
      source: { file, row: draft.row },
    })
    if (parsed.success) cases.push(parsed.data)
    else {
      errors.push({
        row: draft.row,
        code: 'too_long',
        message: parsed.error.issues[0]?.message ?? 'not a valid test case',
      })
    }
  }
  return { columns, mapping, cases, errors: errors.sort((a, b) => (a.row ?? 0) - (b.row ?? 0)) }
}
