import { describe, expect, it } from 'vitest'
import { createRedactor, referenceSecrets } from './redact'

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

  it('turns secret values into ${secret:NAME} references, deep and without mutating', () => {
    const secrets = { TEST_USER: 'bod@example.com', PIN: '123', LONG_USER: 'bod@example.com.vn' }
    const step = {
      id: 's8',
      action: 'tap',
      target: [{ text: 'bod@example.com' }, { text_contains: 'Hi bod@example.com.vn!' }],
      expect: [{ visible_text: 'code 123' }],
    }
    const referenced = referenceSecrets(step, secrets)
    expect(referenced).toEqual({
      id: 's8',
      action: 'tap',
      target: [{ text: '${secret:TEST_USER}' }, { text_contains: 'Hi ${secret:LONG_USER}!' }],
      // Too short to be told from ordinary text (MIN_SECRET_LENGTH).
      expect: [{ visible_text: 'code 123' }],
    })
    expect(step.target[0]?.text).toBe('bod@example.com')
    expect(referenceSecrets(step, {})).toBe(step)
  })
})
