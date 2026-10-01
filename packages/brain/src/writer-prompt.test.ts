import { flowSchema, testPlanSchema } from '@coral/shared'
import { describe, expect, it } from 'vitest'
import { createFakeAdapter, fakeWrite } from './adapters/fake'
import { EMPTY_KNOWLEDGE, NO_TOOLS, type TraceStepInput, type WriteTestInput } from './brain'
import { writeTestPrompt } from './prompts'
import { structuredChat } from './structured'

// T037: the writer sees the trace by step number, never writes a locator, writes ≤ max_tests.

const step = (n: number, over: Partial<TraceStepInput> = {}): TraceStepInput => ({
  n,
  segment: 1,
  screen: 'Catalog',
  after: 'Catalog',
  newScreen: false,
  action: `tap #${n}`,
  status: 'done',
  textsAfter: [],
  candidates: [],
  flags: [],
  ...over,
})

const trace: TraceStepInput[] = [
  step(1, {
    action: 'tap "View menu" (#1)',
    after: 'Menu',
    newScreen: true,
    textsAfter: ['Log In'],
  }),
  step(2, { screen: 'Menu', action: 'tap "Log In" (#10)', after: 'Login', newScreen: true }),
  step(3, {
    screen: 'Login',
    action: 'type secret TEST_PASSWORD into "Password" (#4)',
    after: 'Login',
  }),
  step(4, { screen: 'Login', after: 'Login', action: 'tap "Place Order" (#9)', status: 'refused' }),
  step(5, {
    screen: 'Login',
    action: 'tap "Login" (#5)',
    after: 'Products',
    newScreen: true,
    candidates: ['visible_text "Products"', 'visible {"android_id":"id/productRV"}'],
    flags: ['never_tap'],
  }),
  step(6, { segment: 2, action: 'tap "Sort" (#3)', after: 'Sort by', newScreen: true }),
]
const input: WriteTestInput = { kind: 'explore', maxTests: 3, steps: trace }

describe('writer prompt (T037, contracts/brain.md §3)', () => {
  it('lists steps by number with the screens before and after, flags and candidates', () => {
    const prompt = writeTestPrompt(input, EMPTY_KNOWLEDGE)
    const text = prompt.messages[0]?.role === 'user' ? prompt.messages[0].text : ''
    expect(text.split('\n').filter((l) => /^\d+\. /.test(l))).toEqual([
      '1. [segment 1] on "Catalog": tap "View menu" (#1) (done) → "Menu" (new screen)',
      '2. [segment 1] on "Menu": tap "Log In" (#10) (done) → "Login" (new screen)',
      '3. [segment 1] on "Login": type secret TEST_PASSWORD into "Password" (#4) (done)',
      '4. [segment 1] on "Login": tap "Place Order" (#9) (refused)',
      '5. [segment 1] on "Login": tap "Login" (#5) (done) → "Products" (new screen) [never_tap]',
      '6. [segment 2] on "Catalog": tap "Sort" (#3) (done) → "Sort by" (new screen)',
    ])
    expect(text).toContain('    candidate 1: visible {"android_id":"id/productRV"}')
    expect(prompt.system.volatile).toContain('at most 3 flow(s)')
    expect(prompt.system.stable).toContain('never write locators')
    expect(prompt.task).toEqual({ kind: 'write_test', input })
  })

  it('answers with step numbers and candidate indexes only, at most max_tests flows', async () => {
    const plan = fakeWrite(input)
    expect(plan.flows.map((f) => f.end_step)).toEqual([1, 2, 5])
    // The answer schema has no place for a locator: flows are strict objects.
    expect(flowSchema.safeParse({ ...plan.flows[0], target: [{ text: 'x' }] }).success).toBe(false)
    expect(JSON.stringify(plan)).not.toMatch(/android_id|"text":|"desc":/)
    const { value } = await structuredChat({
      adapter: createFakeAdapter('fake'),
      model: 'fake',
      prompt: writeTestPrompt(input, EMPTY_KNOWLEDGE),
      tools: NO_TOOLS,
    })
    expect(testPlanSchema.parse(value).flows).toHaveLength(3)
    expect(fakeWrite({ ...input, maxTests: 1 }).flows).toHaveLength(1)
  })
})
