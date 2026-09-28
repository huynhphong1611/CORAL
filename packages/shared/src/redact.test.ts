import { describe, expect, it } from 'vitest'
import { createRedactor } from './redact'

describe('createRedactor', () => {
  it('masks every occurrence of every secret', () => {
    const r = createRedactor(['hunter22', 'bob@example.com'])
    expect(r.text('login bob@example.com / hunter22 then hunter22')).toBe(
      'login *** / *** then ***',
    )
  })

  it('masks the longest secret first when secrets overlap', () => {
    const r = createRedactor(['pass', 'password123'])
    expect(r.text('password123 and pass')).toBe('*** and ***')
  })

  it('handles Unicode and regex characters', () => {
    const r = createRedactor(['Mật-khẩu.$1', 'a+b(c)'])
    expect(r.text('x Mật-khẩu.$1 y a+b(c)')).toBe('x *** y ***')
  })

  it('ignores secrets shorter than 4 characters', () => {
    expect(createRedactor(['abc']).text('abc')).toBe('abc')
  })

  it('redacts nested JSON values without mutating the input', () => {
    const input = { steps: [{ text: 'token=s3cr3t', n: 1 }], ok: true, nothing: null }
    const r = createRedactor(['s3cr3t'])
    expect(r.value(input)).toEqual({
      steps: [{ text: 'token=***', n: 1 }],
      ok: true,
      nothing: null,
    })
    expect(input.steps[0]?.text).toBe('token=s3cr3t')
  })
})
