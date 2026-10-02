import { describe, expect, it } from 'vitest'
import { importMappingSchema, manualCasePath, manualCaseSchema } from './schema'

const manual = {
  schema: 'coral/manualcase@1',
  id: 'TC-012',
  title: 'Đăng nhập bằng tài khoản hợp lệ',
  preconditions: ['Ứng dụng mở ở màn danh sách sản phẩm'],
  steps: [
    { action: 'Mở menu, chọn Log In', expected: 'Màn Login hiện ra' },
    { action: 'Nhập username và password, bấm Login' },
  ],
  source: { file: 'manual-login.csv', row: 14 },
}

describe('manualCaseSchema', () => {
  it('keeps the written text and fills the defaults', () => {
    const parsed = manualCaseSchema.parse(manual)
    expect(parsed.steps[0]?.expected).toBe('Màn Login hiện ra')
    expect(parsed.tags).toEqual([])
  })

  it('needs a title and at least one step', () => {
    expect(manualCaseSchema.safeParse({ ...manual, title: '' }).success).toBe(false)
    expect(manualCaseSchema.safeParse({ ...manual, steps: [] }).success).toBe(false)
    expect(manualCaseSchema.safeParse({ ...manual, title: 'x'.repeat(201) }).success).toBe(false)
  })
})

describe('import helpers', () => {
  it('reads a column mapping with defaults', () => {
    expect(importMappingSchema.parse({ title: 1, steps: [2] })).toEqual({
      title: 1,
      steps: [2],
      expected: [],
      header_row: 0,
    })
  })

  it('names manual case files by number and ASCII title', () => {
    expect(manualCasePath('01a0', 7, 'Đăng nhập bằng tài khoản hợp lệ')).toBe(
      'imports/01a0/007-dang-nhap-bang-tai-khoan-hop-le.yaml',
    )
  })
})
