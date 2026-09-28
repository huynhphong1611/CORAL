import { describe, expect, it } from 'vitest'
import expected from '../../../../fixtures/testcases/invalid/expected.json' with { type: 'json' }
import { examples, invalidFixtures, validFixtures } from '../testing/fixtures'
import { validateTestCase, validateTestCaseSource } from './validate'

describe('validateTestCaseSource', () => {
  it('loads every fixture', () => {
    expect(Object.keys(validFixtures).length).toBeGreaterThanOrEqual(2)
    expect(Object.keys(invalidFixtures).sort()).toEqual(Object.keys(expected).sort())
  })

  it.each(Object.entries(validFixtures))('passes %s without errors', (name, source) => {
    const result = validateTestCaseSource(source, name)
    expect(result.errors).toEqual([])
    expect(result.valid).toBe(true)
    expect(result.value?.steps.length).toBeGreaterThan(0)
  })

  // SC-006: every invalid fixture reports exactly the expected errors, with a source position.
  it.each(Object.entries(expected))('reports %s', (name, wanted) => {
    const result = validateTestCaseSource(invalidFixtures[name] ?? '', name)
    expect(result.valid).toBe(false)
    expect(result.errors.map(({ code, step_id, path }) => ({ code, step_id, path }))).toEqual(
      wanted.map((w) => ({ step_id: undefined, ...w })),
    )
    for (const error of result.errors) {
      expect(error.file).toBe(name)
      expect(error.line).toBeGreaterThan(0)
      expect(error.column).toBeGreaterThan(0)
    }
  })

  it('points at the offending line', () => {
    const result = validateTestCaseSource(invalidFixtures['point-pct-not-last.yaml'] ?? '', 'f')
    expect(result.errors[0]).toMatchObject({ line: 9, column: 9 })
  })

  it('passes examples/testcase.example.yaml (ROADMAP: examples must validate)', () => {
    const result = validateTestCaseSource(examples['testcase.example.yaml'] ?? '', 'example')
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('warns about a tap without expect unless an assert follows', () => {
    const tc = (steps: unknown[]) => ({
      schema: 'coral/testcase@1',
      id: 'warn',
      intent: 'x',
      platforms: ['android'],
      steps,
    })
    const tap = { id: 't', action: 'tap', target: [{ text: 'Go' }] }
    const lonely = validateTestCase(tc([tap, { id: 'b', action: 'back' }]))
    expect(lonely.valid).toBe(true)
    expect(lonely.warnings).toMatchObject([
      { code: 'no_expect_after_tap', step_id: 't', path: 'steps[0]' },
    ])
    const followed = validateTestCase(
      tc([tap, { id: 'a', action: 'assert', expect: { visible_text: 'Done' } }]),
    )
    expect(followed.warnings).toEqual([])
  })

  it('checks coverage and interpolation inside expect and nested locators', () => {
    const result = validateTestCase({
      schema: 'coral/testcase@1',
      id: 'nested',
      intent: 'x',
      platforms: ['android', 'ios'],
      variables: { user: '${secret:TEST_USER}' },
      steps: [
        {
          id: 's1',
          action: 'launch',
          expect: [
            { visible: { android_id: 'id/a' } },
            { visible_text: 'Hi ${var:user} ${var:nope}' },
          ],
        },
        {
          id: 's2',
          action: 'tap',
          target: [{ rel: { below: { image: 'snap/x.png' } } }],
          expect: { screen: 'home' },
        },
      ],
    })
    expect(result.errors.map((e) => [e.code, e.path])).toEqual([
      ['var_undeclared', 'steps[0].expect[1].visible_text'],
      ['platform_coverage', 'steps[0].expect[0].visible'],
      ['unsupported_in_phase', 'steps[1].target[0].rel.below'],
      ['unsupported_in_phase', 'steps[1].expect[0].screen'],
    ])
  })

  it('reports YAML syntax errors with a position', () => {
    const result = validateTestCaseSource('schema: [\n', 'broken.yaml')
    expect(result.errors[0]).toMatchObject({ code: 'yaml', file: 'broken.yaml' })
    expect(result.errors[0]?.line).toBeGreaterThan(0)
  })
})
