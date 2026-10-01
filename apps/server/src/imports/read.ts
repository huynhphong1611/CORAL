import type { ImportFormat, ImportMapping } from '@coral/shared'
import type { TableRead } from './mapping'
import { parseCsv } from './parse-csv'
import { parseGherkin } from './parse-gherkin'
import { parseXlsx } from './parse-xlsx'

/** The format of an uploaded file from its name: `.csv`/`.tsv`/`.txt`, `.xlsx`, `.feature`. */
export function formatOf(fileName: string): ImportFormat | undefined {
  const ext = /\.([A-Za-z0-9]+)$/.exec(fileName)?.[1]?.toLowerCase()
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') return 'csv'
  if (ext === 'xlsx') return 'xlsx'
  if (ext === 'feature') return 'gherkin'
  return undefined
}

/** Manual cases of a file in one of the three formats (contracts/manualcase.md). */
export function readImport(
  format: ImportFormat,
  fileName: string,
  bytes: Uint8Array,
  options: { sheet?: string | undefined; mapping?: ImportMapping | null | undefined } = {},
): Promise<TableRead> {
  switch (format) {
    case 'csv':
      return Promise.resolve(parseCsv(fileName, bytes, options.mapping))
    case 'xlsx':
      return parseXlsx(fileName, bytes, options)
    case 'gherkin':
      return Promise.resolve(parseGherkin(fileName, bytes))
  }
}
