import { describe, expect, it } from 'vitest'
import { goalOf } from './service'

// US6 (T054): what the Explorer is asked for a manual case — what shows it is done first, then
// the case as written.

describe('goalOf (T054)', () => {
  it('puts the last expected result first, then the case as written', () => {
    expect(
      goalOf({
        schema: 'coral/manualcase@1',
        id: 'TC-1',
        title: 'Open "the" cart',
        preconditions: ['The catalog shows'],
        steps: [
          { action: 'Tap the menu icon', expected: 'The menu opens' },
          { action: 'Tap the cart icon', expected: '"My Cart" shows' },
        ],
        tags: [],
        source: { file: 'cases.csv', row: 2 },
      }),
    ).toBe(
      [
        'Done when: "My Cart" shows',
        'Follow the manual test case: Open "the" cart',
        'Precondition: The catalog shows',
        '1. Tap the menu icon → expected: The menu opens',
        '2. Tap the cart icon → expected: "My Cart" shows',
      ].join('\n'),
    )
  })
})
