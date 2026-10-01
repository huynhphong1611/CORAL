import { describe, expect, it } from 'vitest'
import { createFakeAdapter } from './adapters/fake'
import type { ScreenInput, ToolSet } from './brain'
import {
  MAX_ELEMENTS,
  decidePrompt,
  describePrompt,
  elementLine,
  screenText,
  writeTestPrompt,
} from './prompts'
import { structuredChat } from './structured'
import { READ_SKILL, combineTools, skillTools } from './tools/skills'

const screen: ScreenInput = {
  width: 1080,
  height: 2400,
  appPackage: 'com.saucelabs.mydemoapp.android',
  knownAs: 'Catalog',
  elements: [
    {
      n: 1,
      className: 'ImageView',
      id: 'menuIV',
      desc: 'View menu',
      bounds: [32, 154, 79, 79],
      flags: ['tried'],
    },
    {
      n: 4,
      className: 'EditText',
      id: 'passwordET',
      bounds: [60, 860, 960, 120],
      flags: ['field', 'password'],
    },
  ],
  visibleTexts: [{ text: 'Products', height: 80 }],
  image: { mediaType: 'image/jpeg', data: 'AAAA', ref: 't/explorations/e/1/ai.jpg' },
}
const knowledge = {
  agentsMd: '# Rules\nNever tap Checkout.',
  skills: [{ name: 'login-demo-account', description: 'Log in with the demo account' }],
  testData: [
    { name: 'username', value: 'bod@example.com' },
    { name: 'password', secret: 'TEST_PASSWORD' },
  ],
}

describe('prompts (research R6, contracts/brain.md §2)', () => {
  it('lists elements by number with id, text, bounds and flags', () => {
    expect(elementLine(screen.elements[0]!)).toBe(
      '#1 ImageView id="menuIV" desc="View menu" [32,154,79,79] tried',
    )
    const text = screenText(screen)
    expect(text.split('\n')).toEqual([
      'Screen 1080x2400 · app com.saucelabs.mydemoapp.android · known as "Catalog"',
      '#1 ImageView id="menuIV" desc="View menu" [32,154,79,79] tried',
      '#4 EditText id="passwordET" [60,860,960,120] field password',
      'Visible text: "Products"',
    ])
    expect(screenText({ ...screen, knownAs: undefined, elements: [] })).toContain('new screen')
    expect(screenText({ ...screen, elements: [] })).toContain('tap_point only')
    const many = Array.from({ length: 100 }, (_, i) => ({ ...screen.elements[0]!, n: i + 1 }))
    expect(
      screenText({ ...screen, elements: many })
        .split('\n')
        .filter((l) => l.startsWith('#')),
    ).toHaveLength(MAX_ELEMENTS)
  })

  it('puts the role, AGENTS.md, skills and test data first; the screen and goal after', () => {
    const prompt = decidePrompt(
      {
        screen,
        goal: 'Log in',
        history: [{ n: 3, screen: 'Catalog', action: 'tap "View menu"', outcome: 'Menu' }],
        budget: { stepsLeft: 7, depth: 2, maxDepth: 8, costUsd: 0.4, maxCostUsd: 3 },
        refused: 'element 9 is in never_tap',
      },
      knowledge,
    )
    expect(prompt.system.stable).toContain('Never tap Checkout.')
    expect(prompt.system.stable).toContain('- login-demo-account: Log in with the demo account')
    expect(prompt.system.stable).toContain('- password: secret TEST_PASSWORD')
    expect(prompt.system.stable).toContain('- username: "bod@example.com"')
    expect(prompt.system.stable).not.toContain('Log in\n')
    expect(prompt.system.volatile).toContain('Goal: Log in')
    expect(prompt.system.volatile).toContain('7 steps left, depth 2/8, cost $0.40 of $3.00')
    const [message] = prompt.messages
    expect(message).toMatchObject({ role: 'user', images: [screen.image] })
    expect(message?.role === 'user' && message.text).toMatch(
      /3\. on "Catalog": tap "View menu" → Menu[\s\S]*refused: element 9/,
    )
    expect(prompt.task.kind).toBe('next_action')
  })

  it('keeps the stable part identical between calls so providers can cache it', () => {
    const a = describePrompt(screen, knowledge).system.stable
    const b = describePrompt({ ...screen, knownAs: 'Other' }, knowledge).system.stable
    expect(a).toBe(b)
    expect(
      describePrompt({ ...screen, image: undefined }, knowledge).messages[0],
    ).not.toHaveProperty('images')
  })

  it('shows the writer the trace with candidates and a manual case to follow', () => {
    const prompt = writeTestPrompt(
      {
        kind: 'import',
        maxTests: 1,
        manualCase: {
          title: 'Login',
          preconditions: ['App installed'],
          steps: [{ action: 'Open menu', expected: 'Log In shows' }],
        },
        steps: [
          {
            n: 1,
            segment: 1,
            screen: 'Catalog',
            after: 'Menu',
            newScreen: true,
            action: 'tap "View menu" (#1)',
            status: 'done',
            textsAfter: ['Log In'],
            candidates: ['visible_text "Log In"'],
            flags: [],
          },
        ],
      },
      knowledge,
    )
    const text = prompt.messages[0]?.role === 'user' ? prompt.messages[0].text : ''
    expect(text).toContain(
      '1. [segment 1] on "Catalog": tap "View menu" (#1) (done) → "Menu" (new screen)',
    )
    expect(text).toContain('new text: "Log In"')
    expect(text).toContain('candidate 0: visible_text "Log In"')
    expect(prompt.system.volatile).toContain('Step 1: Open menu → expected: Log In shows')
    expect(prompt.system.volatile).toContain('at most 1 flow(s)')
  })
})

describe('explorer prompt and read_skill (T030)', () => {
  it('shows only the last 10 steps', () => {
    const history = Array.from({ length: 14 }, (_, i) => ({
      n: i + 1,
      screen: 'Catalog',
      action: `tap #${i + 1}`,
      outcome: 'Catalog',
    }))
    const prompt = decidePrompt(
      {
        screen,
        history,
        budget: { stepsLeft: 1, depth: 0, maxDepth: 8, costUsd: 0, maxCostUsd: 1 },
      },
      knowledge,
    )
    const text = prompt.messages[0]?.role === 'user' ? prompt.messages[0].text : ''
    expect(text).not.toMatch(/^4\. on/m)
    expect(text).toMatch(/^5\. on "Catalog": tap #5/m)
    expect(text).toMatch(/^14\. on/m)
  })

  it('reads the skill the AI names, from this project only, as one tool round', async () => {
    const tools = skillTools(new Map([['login-demo-account', 'Open the menu, then Log In.']]))
    expect(tools.specs.map((s) => s.name)).toEqual([READ_SKILL])
    expect(await tools.call(READ_SKILL, { name: 'login-demo-account' })).toEqual({
      result: 'Open the menu, then Log In.',
      ok: true,
    })
    expect(await tools.call(READ_SKILL, { name: 'other-project-skill' })).toMatchObject({
      ok: false,
    })
    expect(skillTools(new Map()).specs).toEqual([])

    const adapter = createFakeAdapter('fake', {
      tools: (_task, round) =>
        round === 1 ? [{ name: READ_SKILL, args: { name: 'login-demo-account' } }] : undefined,
    })
    const { attempts } = await structuredChat({
      adapter,
      model: 'fake',
      prompt: describePrompt(screen, knowledge),
      tools,
    })
    expect(attempts[0]?.rounds).toHaveLength(1)
    expect(attempts[0]?.rounds[0]?.tool_calls[0]).toMatchObject({
      name: READ_SKILL,
      result: 'Open the menu, then Log In.',
    })
  })

  it('combines tool sets and blocks a name none of them offers', async () => {
    const otp: ToolSet = {
      specs: [{ name: 'otp__get_otp', description: 'OTP', inputSchema: {} }],
      call: () => Promise.resolve({ result: '482913', ok: true }),
    }
    const all = combineTools(skillTools(new Map([['a', 'A']])), otp)
    expect(all.specs.map((s) => s.name)).toEqual([READ_SKILL, 'otp__get_otp'])
    expect(await all.call('otp__get_otp', {})).toMatchObject({ result: '482913' })
    expect(await all.call('otp__delete_user', {})).toMatchObject({
      ok: false,
      blocked: true,
      error: 'not_allowed',
    })
  })
})
