import { describe, expect, it } from 'vitest'
import {
  actionDecisionSchema,
  screenSummarySchema,
  testPlanSchema,
  toJsonSchema,
  type ActionDecision,
} from './decisions'

const ok = (value: unknown) => actionDecisionSchema.safeParse(value).success

describe('actionDecisionSchema', () => {
  it('accepts every action the Explorer can take', () => {
    const decisions: ActionDecision[] = [
      { action: 'tap', element: 12, reason: 'menu not tried yet' },
      { action: 'long_press', element: 3, reason: 'context menu' },
      { action: 'type', element: 3, text: 'backpack', reason: 'search' },
      { action: 'type', element: 4, secret: 'TEST_USER', reason: 'login' },
      { action: 'type', element: 5, test_data: 'shipping_zip', reason: 'form' },
      { action: 'swipe', element: 7, direction: 'up', reason: 'more items' },
      { action: 'back', reason: 'nothing new here' },
      { action: 'hide_keyboard', reason: 'keyboard covers the button' },
      { action: 'restart_app', reason: 'stuck' },
      { action: 'tap_point', point_pct: [0.5, 0.42], reason: 'canvas' },
      { action: 'done', goal_reached: true, reason: 'cart shows 1 item' },
    ]
    for (const d of decisions) expect(actionDecisionSchema.parse(d)).toEqual(d)
  })

  it('rejects what the system cannot act on', () => {
    expect(ok({ action: 'type', element: 3, text: 'a', secret: 'X', reason: 'r' })).toBe(false)
    expect(ok({ action: 'type', element: 3, reason: 'r' })).toBe(false)
    expect(ok({ action: 'type', element: 3, text: 'x'.repeat(65), reason: 'r' })).toBe(false)
    expect(ok({ action: 'tap', element: 0, reason: 'r' })).toBe(false)
    expect(ok({ action: 'tap', element: 2.5, reason: 'r' })).toBe(false)
    expect(ok({ action: 'tap', element: 2, reason: '' })).toBe(false)
    expect(ok({ action: 'tap', element: 2, reason: 'r', x: 10 })).toBe(false)
    expect(ok({ action: 'tap_point', point_pct: [1.2, 0.1], reason: 'r' })).toBe(false)
    expect(ok({ action: 'scroll_forever', reason: 'r' })).toBe(false)
  })
})

describe('screenSummarySchema', () => {
  it('keeps names short', () => {
    expect(screenSummarySchema.safeParse({ name: 'Danh sách sản phẩm', purpose: '' }).success).toBe(
      true,
    )
    expect(screenSummarySchema.safeParse({ name: 'x'.repeat(61), purpose: '' }).success).toBe(false)
  })
})

describe('testPlanSchema', () => {
  const flow = {
    slug: 'open-backpack-details',
    name: 'Mở chi tiết sản phẩm',
    intent: 'Từ danh sách, mở Sauce Labs Backpack và thấy giá',
    segment: 2,
    end_step: 17,
    expects: [
      { step: 17, visible_text: '$29.99' },
      { step: 15, candidate: 0 },
    ],
  }

  it('accepts flows that refer to trace steps only', () => {
    expect(testPlanSchema.parse({ flows: [flow], outcome: 'written' }).flows).toHaveLength(1)
  })

  it('rejects a bad slug, an expectation with two kinds and an unexplained outcome', () => {
    const bad = (plan: unknown) => testPlanSchema.safeParse(plan).success
    expect(bad({ flows: [{ ...flow, slug: 'Bad Slug' }], outcome: 'written' })).toBe(false)
    expect(
      bad({
        flows: [{ ...flow, expects: [{ step: 1, visible_text: 'a', candidate: 0 }] }],
        outcome: 'written',
      }),
    ).toBe(false)
    expect(bad({ flows: [], outcome: 'app_mismatch' })).toBe(false)
    expect(
      bad({ flows: [], outcome: 'app_mismatch', evidence_step: 4, explanation: 'no cart badge' }),
    ).toBe(true)
  })
})

describe('toJsonSchema', () => {
  it('gives strict, flat schemas a provider accepts', () => {
    for (const schema of [actionDecisionSchema, screenSummarySchema, testPlanSchema]) {
      const json = JSON.stringify(toJsonSchema(schema))
      expect(json).not.toContain('"$ref"')
      expect(json).toContain('"additionalProperties":false')
    }
  })
})
