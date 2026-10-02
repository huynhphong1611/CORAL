import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cellText, parseXlsx } from './parse-xlsx'

// US6 (T051): Excel files read like a CSV — the first sheet or the one chosen, numbers and dates
// as text, numbered lines split into steps, rows without a title adding steps.

const xlsx = readFileSync(new URL('../../../../fixtures/manual/mydemo.xlsx', import.meta.url))

describe('XLSX import (T051)', () => {
  it('reads the first sheet: columns guessed, numbers and dates as text', async () => {
    const read = await parseXlsx('mydemo.xlsx', xlsx)
    expect(read.errors).toEqual([])
    expect(read.columns.map((c) => c.header)).toEqual([
      'ID',
      'Title',
      'Steps',
      'Expected Result',
      'Created',
      'Priority',
    ])
    expect(read.mapping).toMatchObject({ id: 0, title: 1, steps: [2], expected: [3] })
    expect(read.cases.map((c) => [c.id, c.title, c.steps, c.source])).toEqual([
      [
        '1',
        'Open the cart',
        [{ action: 'Tap the cart icon', expected: 'My Cart shows' }],
        { file: 'mydemo.xlsx', row: 2 },
      ],
      [
        '2',
        'Log in with the demo account',
        [
          { action: 'Open the menu', expected: 'The menu opens' },
          { action: 'Tap Log In', expected: 'The Login screen shows' },
          {
            action: 'Type the demo username and password, tap Login',
            expected: 'The catalog shows again',
          },
        ],
        { file: 'mydemo.xlsx', row: 3 },
      ],
    ])
  })

  it('reads the sheet chosen; an unknown sheet or a file that is not xlsx is an error', async () => {
    const login = await parseXlsx('mydemo.xlsx', xlsx, { sheet: 'Login' })
    expect(login.cases.map((c) => [c.title, c.steps])).toEqual([
      ['Đăng nhập', [{ action: 'Mở menu, chọn Log In', expected: 'Màn Login hiện ra' }]],
    ])
    expect(await parseXlsx('mydemo.xlsx', xlsx, { sheet: 'Nope' })).toMatchObject({
      cases: [],
      errors: [{ code: 'syntax', message: 'the file has no sheet "Nope"' }],
    })
    const notXlsx = await parseXlsx('x.xlsx', new TextEncoder().encode('Title,Steps\n'))
    expect(notXlsx.errors).toEqual([expect.objectContaining({ code: 'syntax' })])
  })

  it('writes cells as text', () => {
    expect(cellText(1.5)).toBe('1.5')
    expect(cellText(new Date('2026-10-01T00:00:00Z'))).toBe('2026-10-01')
    expect(cellText(new Date('2026-10-01T09:30:00Z'))).toBe('2026-10-01 09:30')
    expect(cellText(true)).toBe('true')
    expect(cellText(null)).toBe('')
  })
})
