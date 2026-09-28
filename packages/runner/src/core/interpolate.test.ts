import { testCaseSchema } from '@coral/shared'
import { describe, expect, it } from 'vitest'
import { createInterpolator, missingSecrets, referencedSecrets } from './interpolate'

const testCase = testCaseSchema.parse({
  schema: 'coral/testcase@1',
  id: 'login',
  intent: 'x',
  platforms: ['android'],
  variables: { username: '${secret:TEST_USER}', greeting: 'Xin chào' },
  steps: [
    { id: 's1', action: 'type', value: '${var:username}', target: [{ text: 'User' }] },
    { id: 's2', action: 'type', value: '${secret:TEST_PASSWORD}' },
    { id: 's3', action: 'launch', expect: { visible_text: '${var:greeting}, ${var:username}' } },
  ],
})

describe('interpolation', () => {
  it('lists referenced and missing secrets before running', () => {
    expect(referencedSecrets(testCase)).toEqual(['TEST_PASSWORD', 'TEST_USER'])
    expect(missingSecrets(testCase, { TEST_USER: 'bob' })).toEqual(['TEST_PASSWORD'])
    expect(missingSecrets(testCase, { TEST_USER: 'bob', TEST_PASSWORD: 'p' })).toEqual([])
  })

  it('replaces vars (through secrets) and secrets', () => {
    const run = createInterpolator(testCase, {
      TEST_USER: 'bob@example.com',
      TEST_PASSWORD: 'Mật-khẩu',
    })
    expect(run('${var:username}')).toBe('bob@example.com')
    expect(run('${secret:TEST_PASSWORD}')).toBe('Mật-khẩu')
    expect(run('${var:greeting}, ${var:username}!')).toBe('Xin chào, bob@example.com!')
    expect(run('no placeholders $ {x}')).toBe('no placeholders $ {x}')
    expect(run.secretValues.sort()).toEqual(['Mật-khẩu', 'bob@example.com'])
  })

  it('throws on unknown names', () => {
    const run = createInterpolator(testCase, { TEST_USER: 'bob', TEST_PASSWORD: 'p' })
    expect(() => run('${var:nope}')).toThrow('variable nope is not declared')
    expect(() => run('${secret:OTHER}')).toThrow('secret OTHER is not set')
  })
})
