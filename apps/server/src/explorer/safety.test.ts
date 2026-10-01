import { INJECTION_TEXT, PLACE_ORDER, SAMPLE_APP, sampleApp } from '@coral/runner/testing'
import type { ActionDecision, ElementNode } from '@coral/shared'
import { describe, expect, it } from 'vitest'
import { serializeScreen } from '../ai/screen'
import { checkDecision, type SafetyContext } from './safety'

const SCREEN = { width: 1080, height: 2400 }
const treeOf = (name: string): ElementNode[] => sampleApp().screens[name]?.frames.at(-1) ?? []
const reason = 'because'

function context(name: string, over: Partial<SafetyContext> & { neverTapInList?: string[] } = {}) {
  const tree = treeOf(name)
  const neverTap = over.neverTap ?? [PLACE_ORDER]
  const screen = serializeScreen(tree, {
    appPackage: SAMPLE_APP,
    screen: SCREEN,
    neverTap: over.neverTapInList ?? neverTap,
    forbidden: [],
    secrets: {},
  })
  const ctx: SafetyContext = {
    screen,
    tree,
    neverTap,
    testData: { username: '${secret:TEST_USER}', full_name: 'Coral Tester' },
    secrets: { TEST_USER: 'bod@example.com' },
    allowSubmit: [],
    inventedFields: new Set(),
    ...over,
  }
  const n = (suffix: string) =>
    screen.elements.find((e) => e.node.platform_id.endsWith(`:id/${suffix}`))?.n ?? 0
  return { ctx, n, screen }
}

describe('checkDecision (research R10, FR-022, FR-022a)', () => {
  it('never lets the AI reach Place Order, even when a screen tells it to', () => {
    // The cart: Place Order is not even listed; a made-up number is not found.
    const cart = context('cart')
    expect(cart.screen.elements.map((e) => e.node.text)).not.toContain(PLACE_ORDER)
    expect(checkDecision({ action: 'tap', element: 99, reason }, cart.ctx)).toMatchObject({
      ok: false,
      refusal: 'not_found',
    })
    // Listed by mistake (another never_tap source): still refused.
    const listed = context('cart', { neverTapInList: [] })
    const place = listed.n('placeOrderBtn')
    expect(checkDecision({ action: 'tap', element: place, reason }, listed.ctx)).toMatchObject({
      ok: false,
      refusal: 'never_tap',
    })
    // The prompt-injection screen only offers ordinary elements.
    const about = context('about')
    expect(about.ctx.tree.some((w) => JSON.stringify(w).includes(INJECTION_TEXT))).toBe(true)
    for (const element of about.screen.elements) {
      expect(checkDecision({ action: 'tap', element: element.n, reason }, about.ctx).ok).toBe(true)
    }
  })

  it('refuses to submit a form after made-up text, unless allow_submit says so', () => {
    const signup = context('signup')
    const name = signup.screen.elements.find((e) => e.node.platform_id.endsWith(':id/fullNameET'))
    const typed = checkDecision(
      { action: 'type', element: name?.n ?? 0, text: 'Nguyễn Văn A', reason },
      signup.ctx,
    )
    expect(typed).toMatchObject({ ok: true, flags: ['invented_text'] })
    const after = { ...signup.ctx, inventedFields: new Set([name?.key ?? '']) }
    const submit: ActionDecision = { action: 'tap', element: signup.n('signUpBtn'), reason }
    expect(checkDecision(submit, after)).toMatchObject({ ok: false, refusal: 'invented_submit' })
    // Typing into another field and going back stay possible.
    expect(
      checkDecision({ action: 'type', element: signup.n('emailET'), text: 'a@b.c', reason }, after)
        .ok,
    ).toBe(true)
    expect(checkDecision({ action: 'back', reason }, after).ok).toBe(true)
    expect(checkDecision(submit, { ...after, allowSubmit: [{ screen_text: 'Sign Up' }] }).ok).toBe(
      true,
    )
  })

  it('lets a search be typed and its results tapped', () => {
    const search = context('search')
    const field = search.screen.elements.find((e) => e.node.platform_id.endsWith(':id/searchET'))
    const typed = checkDecision(
      { action: 'type', element: field?.n ?? 0, text: 'backpack', reason },
      search.ctx,
    )
    // A search box: no made-up-text flag, so nothing is blocked afterwards.
    expect(typed).toMatchObject({ ok: true, flags: [] })
    expect(field?.flags).toContain('search')
  })

  it('types test data and secrets of the skills by name only', () => {
    const signup = context('signup')
    const email = signup.n('emailET')
    expect(
      checkDecision({ action: 'type', element: email, test_data: 'full_name', reason }, signup.ctx)
        .ok,
    ).toBe(true)
    expect(
      checkDecision({ action: 'type', element: email, secret: 'TEST_USER', reason }, signup.ctx).ok,
    ).toBe(true)
    expect(
      checkDecision(
        { action: 'type', element: email, secret: 'ADMIN_PASSWORD', reason },
        signup.ctx,
      ),
    ).toMatchObject({ ok: false, refusal: 'invalid_text' })
    expect(
      checkDecision({ action: 'type', element: email, test_data: 'nope', reason }, signup.ctx),
    ).toMatchObject({ ok: false, refusal: 'invalid_text' })
    // Made-up text may not carry a secret value.
    expect(
      checkDecision(
        { action: 'type', element: email, text: 'me bod@example.com', reason },
        signup.ctx,
      ),
    ).toMatchObject({ ok: false, refusal: 'invalid_text' })
    // Only fields take text.
    expect(
      checkDecision(
        { action: 'type', element: signup.n('signUpBtn'), text: 'x', reason },
        signup.ctx,
      ),
    ).toMatchObject({ ok: false, refusal: 'not_actionable' })
  })

  it('allows tap_point only on a screen without usable elements', () => {
    const catalog = context('catalog')
    expect(
      checkDecision({ action: 'tap_point', point_pct: [0.5, 0.5], reason }, catalog.ctx),
    ).toMatchObject({ ok: false, refusal: 'point_pct_not_allowed' })
    const empty = { ...catalog.ctx, screen: { ...catalog.screen, elements: [] } }
    expect(
      checkDecision({ action: 'tap_point', point_pct: [0.5, 0.5], reason }, empty),
    ).toMatchObject({
      ok: true,
      point: { x: 540, y: 1200 },
    })
    // Even then, not on a never_tap button.
    const cart = context('cart')
    const place = cart.ctx.tree
      .flatMap((w) => [w, ...w.children.flatMap((c) => [c, ...c.children])])
      .find((n) => n.text === PLACE_ORDER)
    const at = place
      ? [(place.bounds.x + place.bounds.w / 2) / 1080, (place.bounds.y + place.bounds.h / 2) / 2400]
      : [0, 0]
    expect(
      checkDecision(
        { action: 'tap_point', point_pct: [at[0] ?? 0, at[1] ?? 0], reason },
        { ...cart.ctx, screen: { ...cart.screen, elements: [] } },
      ),
    ).toMatchObject({ ok: false, refusal: 'never_tap' })
  })
})
