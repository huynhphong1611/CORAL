import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseGherkin } from './parse-gherkin'

// US6 (T052): Gherkin to manual cases — Given and Background as preconditions, When as steps,
// Then as the expected result of the step before; an outline gives one case per example row;
// a syntax error is reported at its line while the other scenarios are still read.

const fixture = (name: string) =>
  readFileSync(new URL(`../../../../fixtures/manual/${name}`, import.meta.url))

describe('Gherkin import (T052)', () => {
  it('maps Background, Given, When and Then; tags carry the feature name', () => {
    const read = parseGherkin('shop.feature', fixture('shop.feature'))
    expect(read.cases.map((c) => c.title)).toEqual([
      'Open the cart',
      'Log in with the demo account',
      'Open a product (Sauce Labs Backpack)',
      'Open a product (Sauce Labs Onesie)',
    ])
    const [cart, login, backpack] = read.cases
    expect(cart).toEqual({
      schema: 'coral/manualcase@1',
      id: '001',
      title: 'Open the cart',
      preconditions: ['the app is open on the catalog'],
      steps: [{ action: 'I tap the cart icon', expected: 'My Cart shows\nthe cart is empty' }],
      tags: ['Shopping', 'shop', 'smoke'],
      source: { file: 'shop.feature', line: 8 },
    })
    expect(login?.preconditions).toEqual(['the app is open on the catalog', 'I am logged out'])
    expect(login?.steps).toEqual([
      { action: 'I open the menu' },
      { action: 'I tap Log In', expected: 'the Login screen shows' },
      { action: 'I type the demo username and password\nbod@example.com' },
      { action: 'I tap Login', expected: 'the catalog shows again' },
    ])
    expect(backpack).toMatchObject({
      steps: [
        { action: 'I tap the product "Sauce Labs Backpack"', expected: 'its price $ 29.99 shows' },
      ],
      source: { file: 'shop.feature', line: 31 },
    })
    // A scenario with no When is not a test case.
    expect(read.errors).toEqual([
      { line: 34, code: 'missing_steps', message: '"Only a precondition" has no When step' },
    ])
  })

  it('reports a syntax error at its line and still reads the other scenarios', () => {
    const read = parseGherkin('broken.feature', fixture('broken.feature'))
    expect(read.errors).toEqual([expect.objectContaining({ line: 10, code: 'syntax' })])
    expect(read.cases.map((c) => [c.title, c.source.line])).toEqual([
      ['Open the menu', 3],
      ['Open the catalog', 13],
    ])
  })

  it('reads another language', () => {
    const read = parseGherkin('vi.feature', fixture('vi.feature'))
    expect(read.errors).toEqual([])
    expect(read.cases.map((c) => [c.title, c.steps, c.tags])).toEqual([
      [
        'Mở giỏ hàng',
        [{ action: 'tôi bấm biểu tượng giỏ hàng', expected: 'màn My Cart hiện ra' }],
        ['Giỏ hàng'],
      ],
    ])
    const broken = parseGherkin('x.feature', new TextEncoder().encode('Not gherkin at all\n'))
    expect(broken.cases).toEqual([])
    expect(broken.errors).toEqual([expect.objectContaining({ line: 1, code: 'syntax' })])
  })
})
