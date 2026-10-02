import { androidTree } from '@coral/runner/testing'
import type { Step } from '@coral/shared'
import { describe, expect, it } from 'vitest'
import {
  actionSummary,
  contentHash,
  countTransitions,
  transitionAction,
  transitionsOf,
  type TraceRow,
} from './trace'

const tap = (n: number, desc: string): Step => ({
  id: `s${n}`,
  action: 'tap',
  target: [{ image: `snap/recording/s${n}/element.png` }, { desc }],
  expect: [{ visible_text: 'Menu' }],
})
const row = (n: number, fingerprint: string, over: Partial<TraceRow> = {}): TraceRow => ({
  n,
  segment: 1,
  fingerprint,
  status: 'done',
  step: tap(n, `#${n}`),
  ...over,
})

describe('trace helpers (T032)', () => {
  it('keeps a transition step without id, expectation nor image locator', () => {
    expect(transitionAction(tap(3, 'View menu'))).toEqual({
      action: 'tap',
      target: [{ desc: 'View menu' }],
    })
    expect(transitionAction({ id: 's4', action: 'back' })).toEqual({ action: 'back' })
  })

  it('reads transitions from consecutive steps of one segment that changed screen', () => {
    const rows = [
      row(1, 'a'),
      row(2, 'b'),
      row(3, 'b', { status: 'refused', step: null }),
      row(4, 'b'),
      row(5, 'c', { segment: 2 }),
      row(6, 'a', { segment: 2 }),
      row(7, 'a', { segment: 2, status: 'popup', step: null }),
      row(8, 'd', { segment: 2 }),
    ]
    expect(transitionsOf([...rows].reverse()).map((t) => [t.from, t.to])).toEqual([
      ['a', 'b'],
      ['c', 'a'],
    ])
    const twice = [...transitionsOf(rows), ...transitionsOf(rows)]
    expect(countTransitions(twice)).toBe(2)
  })

  it('sees typed text as a change, unlike the structure hash of the runner', () => {
    const tree = androidTree('login')
    const typed = structuredClone(tree)
    const field = typed[0]?.children[0]
    if (!field) throw new Error('fixture changed')
    field.text = 'bod@example.com'
    expect(contentHash(typed)).not.toBe(contentHash(tree))
    expect(contentHash(structuredClone(tree))).toBe(contentHash(tree))
  })

  it('summarises an action for the history and the web', () => {
    const node = androidTree('login')[0]?.children[0]
    if (!node) throw new Error('fixture changed')
    const label = { ...node, text: 'Log In' }
    expect(actionSummary({ action: 'tap', element: 4, reason: 'r' }, label)).toBe(
      'tap "Log In" (#4)',
    )
    expect(
      actionSummary({ action: 'type', element: 2, secret: 'TEST_PASSWORD', reason: 'r' }),
    ).toBe('type secret TEST_PASSWORD into field (#2)')
    expect(actionSummary({ action: 'swipe', element: 1, direction: 'up', reason: 'r' })).toBe(
      'swipe up (#1)',
    )
    expect(actionSummary({ action: 'tap_point', point_pct: [0.5, 0.25], reason: 'r' })).toBe(
      'tap at 50%, 25%',
    )
    expect(actionSummary({ action: 'hide_keyboard', reason: 'r' })).toBe('hide keyboard')
    expect(actionSummary(null, undefined, 'back')).toBe('back (system)')
    expect(actionSummary(null, undefined, 'restart_app')).toBe('restart the app')
  })
})
