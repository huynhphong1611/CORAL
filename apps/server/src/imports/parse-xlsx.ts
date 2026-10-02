import type { ImportMapping } from '@coral/shared'
import {
  InvalidInputError,
  InvalidSpreadsheetError,
  readSheet,
  SheetNotFoundError,
} from 'read-excel-file/node'
import { readTable, type TableRead } from './mapping'

/** A cell as text: a number as written, a date as its day (and time when it has one). */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) {
    const iso = value.toISOString()
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ')
  }
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/**
 * An Excel file (`.xlsx`) as manual cases (contracts/manualcase.md): its first sheet, or the one
 * named; then the same columns and rows as a CSV. A file that is not `.xlsx`, or a sheet it does
 * not have, is one `syntax` error.
 */
export async function parseXlsx(
  file: string,
  bytes: Uint8Array,
  options: { sheet?: string | undefined; mapping?: ImportMapping | null | undefined } = {},
): Promise<TableRead> {
  const input = Buffer.from(bytes)
  let data
  try {
    data =
      options.sheet === undefined ? await readSheet(input) : await readSheet(input, options.sheet)
  } catch (error) {
    const message =
      error instanceof SheetNotFoundError
        ? `the file has no sheet "${options.sheet ?? ''}"`
        : error instanceof InvalidInputError || error instanceof InvalidSpreadsheetError
          ? `not an .xlsx file: ${error.message}`
          : undefined
    if (!message) throw error
    return { columns: [], mapping: null, cases: [], errors: [{ code: 'syntax', message }] }
  }
  return readTable(
    file,
    data.map((row) => row.map(cellText)),
    options.mapping,
  )
}
