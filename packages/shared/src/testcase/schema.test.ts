import { describe, expect, it } from 'vitest'
import { examples, validFixtures } from '../testing/fixtures'
import { parseYaml } from './parse'
import { STEP_ACTIONS, locatorSchema, stepSchema, testCaseSchema } from './schema'

const parse = (source: string) => testCaseSchema.safeParse(parseYaml(source).value)

describe('coral/testcase@1 schema', () => {
  it.each(Object.entries(validFixtures))('accepts fixture %s', (_name, source) => {
    const result = parse(source)
    expect(result.error?.issues).toBeUndefined()
  })

  it('accepts examples/testcase.example.yaml', () => {
    expect(parse(examples['testcase.example.yaml'] ?? '').success).toBe(true)
  })

  it('covers every action of SPEC §7.1 in all-actions.yaml', () => {
    const tc = testCaseSchema.parse(parseYaml(validFixtures['all-actions.yaml'] ?? '').value)
    expect(new Set(tc.steps.map((s) => s.action))).toEqual(new Set(STEP_ACTIONS))
  })

  it('normalizes a single expect condition to a list', () => {
    const step = stepSchema.parse({ id: 's1', action: 'launch', expect: { visible_text: 'Hi' } })
    expect(step.expect).toEqual([{ visible_text: 'Hi' }])
  })

  it('requires exactly one key per locator', () => {
    expect(locatorSchema.safeParse({ text: 'a' }).success).toBe(true)
    expect(locatorSchema.safeParse({}).success).toBe(false)
    expect(locatorSchema.safeParse({ text: 'a', desc: 'b' }).success).toBe(false)
    expect(
      locatorSchema.safeParse({ rel: { below: { text: 'a' }, above: { text: 'b' } } }).success,
    ).toBe(false)
    expect(locatorSchema.safeParse({ point_pct: [0.5, 1.2] }).success).toBe(false)
    expect(locatorSchema.safeParse({ nope: 'x' }).success).toBe(false)
  })

  it.each([
    ['launch with a target', { action: 'launch', target: [{ text: 'a' }] }],
    ['long_press ms out of range', { action: 'long_press', ms: 50, target: [{ text: 'a' }] }],
    ['long_press ms as text', { action: 'long_press', ms: 'slow', target: [{ text: 'a' }] }],
    [
      'swipe with direction and points',
      { action: 'swipe', direction: 'up', from: [0, 0], to: [1, 1] },
    ],
    ['swipe with only from', { action: 'swipe', from: [0, 0] }],
    ['scroll_to max_swipes 0', { action: 'scroll_to', max_swipes: 0, target: [{ text: 'a' }] }],
    ['wait with ms and until', { action: 'wait', ms: 10, until: { visible_text: 'a' } }],
    ['wait over 60 s', { action: 'wait', ms: 60_001 }],
    ['assert without expect', { action: 'assert' }],
    [
      'expect timeout too long',
      { action: 'launch', expect: { visible_text: 'a', timeout_ms: 200_000 } },
    ],
    ['unknown action', { action: 'fly' }],
    ['relative deeplink', { action: 'open_deeplink', url: '/path' }],
  ])('rejects %s', (_name, step) => {
    expect(stepSchema.safeParse({ id: 's1', ...step }).success).toBe(false)
  })

  it('rejects unknown platforms and top-level keys', () => {
    const base = {
      schema: 'coral/testcase@1',
      id: 'ok-id',
      intent: 'x',
      steps: [{ id: 's1', action: 'launch' }],
    }
    expect(testCaseSchema.safeParse({ ...base, platforms: ['android'] }).success).toBe(true)
    expect(testCaseSchema.safeParse({ ...base, platforms: ['web'] }).success).toBe(false)
    expect(testCaseSchema.safeParse({ ...base, platforms: [] }).success).toBe(false)
    expect(testCaseSchema.safeParse({ ...base, platforms: ['android'], extra: 1 }).success).toBe(
      false,
    )
    expect(
      testCaseSchema.safeParse({ ...base, id: 'Bad Id', platforms: ['android'] }).success,
    ).toBe(false)
  })
})
