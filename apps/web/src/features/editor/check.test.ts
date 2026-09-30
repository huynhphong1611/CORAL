import { describe, expect, it } from 'vitest'
import { checkTestCase } from './check'

const yaml = (id = 'login', extra = '') => `schema: coral/testcase@1
id: ${id}
intent: Log in
platforms: [android]
steps:
  - id: s1
    action: launch
    expect: { visible_text: Login }
  - id: s2
    action: tap
    target: [{ text: Login }]${extra}
`

describe('checkTestCase (US5)', () => {
  it('accepts a valid test case and keeps its warnings', () => {
    const checked = checkTestCase(yaml(), 'login')
    expect(checked.errors).toEqual([])
    expect(checked.warnings.map((w) => w.code)).toEqual(['no_expect_after_tap'])
    expect(checked.testCase?.steps.map((s) => s.id)).toEqual(['s1', 's2'])
  })

  it('reports schema errors on their line and step', () => {
    const checked = checkTestCase(
      yaml('login', '\n    expect: { visible_text: Home, timeout_ms: 50 }'),
      'login',
    )
    expect(checked.errors).toEqual([
      expect.objectContaining({ code: 'schema', step_id: 's2', line: 12 }),
    ])
  })

  it('reports YAML syntax errors with a position', () => {
    const checked = checkTestCase('schema: [\n', 'login')
    expect(checked.errors[0]).toMatchObject({ line: expect.any(Number) as number })
    expect(checked.testCase).toBeUndefined()
  })

  it('refuses a changed id (the slug is the file name)', () => {
    const checked = checkTestCase(yaml('logout'), 'login')
    expect(checked.errors).toEqual([
      expect.objectContaining({ code: 'id_changed', line: 2, column: 1 }),
    ])
  })
})
