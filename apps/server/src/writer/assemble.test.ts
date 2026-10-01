import { SAMPLE_APP, sampleApp } from '@coral/runner/testing'
import { walkTree, type ElementNode, type Flow, type Step } from '@coral/shared'
import { describe, expect, it } from 'vitest'
import { assemble, AssembleError, freeSlug, signatureOf, type WriterRow } from './assemble'

// T038 (research R12): YAML from the recorded trace — valid, made-up expectations dropped,
// tap + type merged, round trips removed, secrets never written, flags carried.

const SECRET = 'bod@example.com'
const screens = sampleApp().screens
const frame = (name: string) => structuredClone(screens[name]?.frames[0] ?? [])

/** The sign-up screen with its full name field focused (after a tap on it). */
function focused(): ElementNode[] {
  const tree = frame('signup')
  for (const node of walkTree(tree)) {
    if (node.platform_id.endsWith(':id/fullNameET')) {
      node.android = {
        password: false,
        focused: true,
        scrollable: false,
        drawing_order: 0,
        window_index: 0,
      }
    }
  }
  return tree
}

const image = (n: number) => ({
  image: { path: `snap/recording/s${n}/element.png`, screen_width: 1080 },
})
const tap = (n: number, locator: Record<string, string>): Step => ({
  id: `s${n}`,
  action: 'tap',
  target: [locator, image(n)],
})

const row = (n: number, fingerprint: string, over: Partial<WriterRow> = {}): WriterRow => ({
  n,
  segment: 1,
  fingerprint,
  status: 'done',
  step: null,
  suggestions: [],
  flags: [],
  ...over,
})

const rows: WriterRow[] = [
  row(1, 'catalog', {
    step: tap(1, { android_id: 'id/menuIV' }),
    suggestions: [{ visible_text: 'Log In' }],
  }),
  row(2, 'menu', {
    step: { id: 's2', action: 'swipe', from: [0.3, 0.7], to: [0.3, 0.3] } as Step,
  }),
  row(3, 'menu', { step: { id: 's3', action: 'tap', target: [{ text: 'Catalog' }] } as Step }),
  row(4, 'catalog', {
    step: tap(4, { android_id: 'id/cartIV' }),
    suggestions: [{ visible_text: 'My Cart' }],
  }),
  row(5, 'cart', { status: 'refused' }),
  row(6, 'cart', { step: tap(6, { android_id: 'id/menuIV' }), flags: ['never_tap'] }),
  row(7, 'menu', {
    step: { id: 's7', action: 'tap', target: [{ text: 'Sign Up' }] } as Step,
    suggestions: [{ visible_text: 'Full name' }],
  }),
  row(8, 'signup', {
    step: { id: 's8', action: 'tap', target: [{ android_id: 'id/fullNameET' }] } as Step,
  }),
  row(9, 'signup', {
    step: {
      id: 's9',
      action: 'type',
      target: [{ android_id: 'id/fullNameET' }],
      value: SECRET,
    } as Step,
    flags: ['mcp_value'],
  }),
  row(10, 'signup'),
  row(11, 'catalog', { segment: 2, step: tap(11, { android_id: 'id/cartIV' }) }),
  row(12, 'cart', { segment: 2 }),
]
const trees: Record<number, ElementNode[]> = {
  1: frame('catalog'),
  2: frame('menu'),
  3: frame('menu'),
  4: frame('catalog'),
  5: frame('cart'),
  6: frame('cart'),
  7: frame('menu'),
  8: frame('signup'),
  9: focused(),
  10: focused(),
  11: frame('catalog'),
  12: frame('cart'),
}

const flow = (over: Partial<Flow>): Flow => ({
  slug: 'open-cart',
  name: 'Open the cart',
  intent: 'Open the cart from the catalog',
  segment: 1,
  end_step: 4,
  expects: [],
  ...over,
})

const build = (f: Flow, slug = f.slug) =>
  assemble({
    flow: f,
    slug,
    rows,
    tree: (n) => trees[n],
    hasElement: (n) => n !== 6,
    appPackage: SAMPLE_APP,
    secrets: { TEST_USER: SECRET },
  })

describe('assemble (T038, research R12)', () => {
  it('starts fresh, drops the round trip through the menu and keeps checked expectations', () => {
    const made = build(
      flow({
        expects: [
          { step: 4, candidate: 0 },
          { step: 4, visible_text: 'Totally made up' },
        ],
      }),
    )
    expect(made.kept).toEqual([4])
    expect(made.testCase).toMatchObject({
      id: 'open-cart',
      intent: 'Open the cart from the catalog',
      preconditions: { app_state: 'fresh' },
    })
    expect(made.testCase.steps).toEqual([
      { id: 's1', action: 'launch' },
      {
        id: 's2',
        action: 'tap',
        target: [
          { android_id: 'id/cartIV' },
          { image: { path: 'snap/open-cart/s2/element.png', screen_width: 1080 } },
        ],
        expect: [{ visible_text: 'My Cart' }],
      },
    ])
    expect(made.snapshots.map((s) => [s.path, s.n, s.file])).toEqual([
      ['snap/open-cart/s1/screen.jpg', 1, 'screen.jpg'],
      ['snap/open-cart/s1/tree.json', 1, 'tree.json'],
      ['snap/open-cart/s2/screen.jpg', 4, 'step.jpg'],
      ['snap/open-cart/s2/tree.json', 4, 'step.json'],
      ['snap/open-cart/s2/element.png', 4, 'element.png'],
    ])
    expect(made.yaml).toContain('schema: coral/testcase@1')
    expect(made.flags).toEqual([])
    expect(made.draftReason).toBeNull()
  })

  it('merges tap + type, keeps secrets as references and carries the flags', () => {
    const made = build(
      flow({
        slug: 'sign-up',
        intent: 'Open Sign Up and fill in the name',
        end_step: 9,
        expects: [
          { step: 7, visible_text: 'Nope, not there' },
          { step: 7, visible_text: 'Sign Up' },
          { step: 9, visible_text: SECRET },
        ],
      }),
    )
    expect(made.kept).toEqual([4, 6, 7, 9])
    expect(made.testCase.steps.map((s) => s.action)).toEqual([
      'launch',
      'tap',
      'tap',
      'tap',
      'type',
    ])
    const [, cart, menu, signUp, name] = made.testCase.steps
    expect(cart).toMatchObject({ expect: [{ visible_text: 'My Cart' }] })
    // No cut-out of step 6 in the trace: no image locator either.
    expect(menu).toEqual({ id: 's3', action: 'tap', target: [{ android_id: 'id/menuIV' }] })
    expect(signUp).toMatchObject({ expect: [{ visible_text: 'Sign Up' }] })
    expect(name).toEqual({
      id: 's5',
      action: 'type',
      target: [{ android_id: 'id/fullNameET' }],
      value: '${secret:TEST_USER}',
    })
    expect(made.yaml).not.toContain(SECRET)
    expect(made.flags).toEqual(['needs_review_never_tap'])
    expect(made.draftReason).toBe('needs_human')
  })

  it('gives the same signature to the same journey, and refuses flows without steps', () => {
    const fromCatalog = build(flow({ segment: 2, end_step: 11 }), 'open-cart-2')
    expect(fromCatalog.signature).toBe(build(flow({})).signature)
    expect(fromCatalog.signature).toBe(
      signatureOf([
        { id: 's1', action: 'launch' },
        { id: 'x', action: 'tap', target: [{ android_id: 'id/cartIV' }] },
      ]),
    )
    expect(freeSlug(new Set(['open-cart']), 'open-cart')).toBe('open-cart-2')
    expect(freeSlug(new Set(['open-cart', 'open-cart-2']), 'open-cart')).toBe('open-cart-3')
    expect(freeSlug(new Set(), 'open-cart')).toBe('open-cart')
    expect(() => build(flow({ end_step: 5 }))).toThrow(AssembleError)
    expect(() => build(flow({ segment: 3, end_step: 4 }))).toThrow(/no recorded step/)
  })
})
