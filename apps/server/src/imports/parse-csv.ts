import type { ImportMapping } from '@coral/shared'
import { CsvError, parse } from 'csv-parse/sync'
import { readTable, type Rows, type TableRead } from './mapping'

const DELIMITERS = [',', ';', '\t']

/** The delimiter of a CSV: the one found most on its first line, outside quotes. */
export function detectDelimiter(text: string): string {
  const counts = new Map<string, number>()
  let quoted = false
  for (const ch of text) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && (ch === '\n' || ch === '\r')) break
    else if (!quoted && DELIMITERS.includes(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ','
}

/**
 * The rows of a CSV file: UTF-8 with or without a BOM, `,` `;` or tab, cells across lines in
 * quotes. Bytes that are not UTF-8 are read as U+FFFD, so that their row is reported.
 */
export function csvRows(bytes: Uint8Array): Rows {
  const text = new TextDecoder('utf-8').decode(bytes)
  return parse(text, {
    delimiter: detectDelimiter(text),
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: false,
  })
}

/** A CSV file as manual cases (contracts/manualcase.md); a broken file is one `syntax` error. */
export function parseCsv(
  file: string,
  bytes: Uint8Array,
  mapping?: ImportMapping | null,
): TableRead {
  let rows: Rows
  try {
    rows = csvRows(bytes)
  } catch (error) {
    if (!(error instanceof CsvError)) throw error
    const line = (error as CsvError & { lines?: number }).lines
    return {
      columns: [],
      mapping: null,
      cases: [],
      errors: [{ ...(line ? { line } : {}), code: 'syntax', message: error.message }],
    }
  }
  return readTable(file, rows, mapping)
}
