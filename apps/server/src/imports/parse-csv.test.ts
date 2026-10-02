import { readFileSync } from 'node:fs'
import { MAX_IMPORT_CASES } from '@coral/shared'
import { describe, expect, it } from 'vitest'
import { guessMapping, normalizeHeader, splitItems } from './mapping'
import { detectDelimiter, parseCsv } from './parse-csv'

// US6 (T050): CSV files to manual cases — BOM, `,` `;` tab, columns guessed by their names
// (accents left out), rows without a title adding steps, numbered lines split into steps, and
// the rows in error reported by row while the rest is still read.

const fixture = (name: string) =>
  readFileSync(new URL(`../../../../fixtures/manual/${name}`, import.meta.url))
const bytes = (text: string) => new TextEncoder().encode(text)

describe('CSV import (T050)', () => {
  it('reads numbered lines of a cell as steps, each with its expected result', () => {
    const read = parseCsv('login-en.csv', fixture('login-en.csv'))
    expect(read.errors).toEqual([])
    expect(read.columns.map((c) => c.header)).toEqual([
      'ID',
      'Title',
      'Preconditions',
      'Steps',
      'Expected Result',
      'Priority',
    ])
    expect(read.mapping).toEqual({
      id: 0,
      title: 1,
      preconditions: 2,
      steps: [3],
      expected: [4],
      header_row: 0,
    })
    expect(read.cases).toEqual([
      {
        schema: 'coral/manualcase@1',
        id: 'TC-01',
        title: 'Log in with the demo account',
        preconditions: ['The app is open on the catalog'],
        steps: [
          { action: 'Open the menu', expected: 'The menu opens' },
          { action: 'Tap Log In', expected: 'The Login screen shows' },
          {
            action: 'Type the demo username and password, tap Login',
            expected: 'The catalog shows again',
          },
        ],
        tags: [],
        source: { file: 'login-en.csv', row: 2 },
      },
      {
        schema: 'coral/manualcase@1',
        id: 'TC-02',
        title: 'Open the cart',
        preconditions: [],
        steps: [{ action: 'Tap the cart icon', expected: 'My Cart shows' }],
        tags: [],
        source: { file: 'login-en.csv', row: 3 },
      },
    ])
  })

  it('reads a BOM, semicolons and Vietnamese headers; a row without a title adds a step', () => {
    const read = parseCsv('vi.csv', fixture('vi-semicolon.csv'))
    expect(read.errors).toEqual([])
    expect(read.columns[0]?.header).toBe('Mã')
    expect(read.mapping).toMatchObject({ id: 0, title: 1, preconditions: 2, steps: [3] })
    expect(read.cases.map((c) => [c.id, c.title, c.steps, c.source.row])).toEqual([
      [
        'TC-10',
        'Xem chi tiết sản phẩm',
        [
          { action: 'Bấm vào sản phẩm đầu tiên', expected: 'Màn chi tiết hiện ra' },
          { action: 'Bấm nút quay lại', expected: 'Danh sách sản phẩm hiện lại' },
        ],
        2,
      ],
      ['TC-11', 'Mở menu', [{ action: 'Bấm biểu tượng menu', expected: 'Menu hiện ra' }], 4],
    ])
  })

  it('reports rows in error by row and keeps reading', () => {
    const read = parseCsv('errors.csv', fixture('errors.csv'))
    expect(read.errors.map((e) => [e.row, e.code])).toEqual([
      [2, 'missing_title'],
      [3, 'missing_steps'],
    ])
    // Without an id column the case is numbered.
    expect(read.cases.map((c) => [c.id, c.title])).toEqual([['001', 'Browse the catalog']])

    const long = 'x'.repeat(4001)
    const tooLong = parseCsv('long.csv', bytes(`Title,Steps\nA,${long}\n,a step of A\nB,Tap B\n`))
    expect(tooLong.errors.map((e) => [e.row, e.code])).toEqual([[2, 'too_long']])
    // A case with a row in error is left out whole.
    expect(tooLong.cases.map((c) => c.title)).toEqual(['B'])

    // A byte that is not UTF-8 (Latin-1 "é").
    const latin = Uint8Array.from([...bytes('Title,Steps\nCaf'), 0xe9, ...bytes(',Tap\nB,Tap B\n')])
    const encoding = parseCsv('latin.csv', latin)
    expect(encoding.errors.map((e) => [e.row, e.code])).toEqual([[2, 'bad_encoding']])
    expect(encoding.cases.map((c) => c.title)).toEqual(['B'])
  })

  it('reads at most 200 cases, tabs, and asks for the columns it cannot guess', () => {
    const many = Array.from({ length: MAX_IMPORT_CASES + 2 }, (_, i) => `Case ${i}\tStep ${i}`)
    const read = parseCsv('many.tsv', bytes(`Name\tAction\n${many.join('\n')}\n`))
    expect(read.cases).toHaveLength(MAX_IMPORT_CASES)
    expect(read.errors).toEqual([
      expect.objectContaining({ row: MAX_IMPORT_CASES + 2, code: 'too_many_cases' }),
    ])

    const unknown = parseCsv('odd.csv', bytes('Foo,Bar\nA,B\n'))
    expect(unknown).toMatchObject({
      mapping: null,
      cases: [],
      errors: [{ code: 'no_mapping' }],
    })
    // The person chooses the columns.
    const chosen = parseCsv('odd.csv', bytes('Foo,Bar\nA,B\n'), {
      title: 0,
      steps: [1],
      expected: [],
      header_row: 0,
    })
    expect(chosen.cases.map((c) => [c.title, c.steps])).toEqual([['A', [{ action: 'B' }]]])

    expect(parseCsv('bad.csv', bytes('Title,Steps\n"A,B\n'))).toMatchObject({
      errors: [{ code: 'syntax' }],
    })
  })

  it('guesses columns by name, one per step, and splits cells into items', () => {
    expect(normalizeHeader(' Kết quả mong đợi ')).toBe('ket qua mong doi')
    expect(guessMapping(['Tên', 'Bước 1', 'Bước 2', 'Kết quả'])).toEqual({
      title: 0,
      steps: [1, 2],
      expected: [3],
      header_row: 0,
    })
    expect(guessMapping(['Summary', 'Notes'])).toBeNull()
    expect(splitItems('1. Open\n   the menu\n2) Tap Log In')).toEqual([
      { n: 1, text: 'Open\nthe menu' },
      { n: 2, text: 'Tap Log In' },
    ])
    expect(splitItems('- Open\n- Tap')).toEqual([{ text: 'Open' }, { text: 'Tap' }])
    expect(splitItems('Open the menu\nand wait')).toEqual([{ text: 'Open the menu\nand wait' }])
    expect(detectDelimiter('"a;b",c,d\n1;2;3;4;5')).toBe(',')
    expect(detectDelimiter('a;b;c')).toBe(';')
  })

  it('reads several step columns, the expected result on the last', () => {
    const read = parseCsv(
      'cols.csv',
      bytes('Title,Step 1,Step 2,Expected\nLog in,Open the menu,Tap Log In,Login shows\n'),
    )
    expect(read.cases[0]?.steps).toEqual([
      { action: 'Open the menu' },
      { action: 'Tap Log In', expected: 'Login shows' },
    ])
  })
})
