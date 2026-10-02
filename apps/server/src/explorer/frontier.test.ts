import { describe, expect, it } from 'vitest'
import { Frontier, STUCK_AFTER } from './frontier'

const A = 'aaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbb'
const C = 'cccccccccccccccc'

describe('Frontier (research R9, FR-024)', () => {
  it('remembers tried and dead elements per screen', () => {
    const f = new Frontier()
    f.record({ from: A, to: B, key: 'menu', treeChanged: true })
    f.record({ from: B, to: B, key: 'title', treeChanged: false })
    f.record({ from: B, to: B, key: 'field', treeChanged: true })
    expect([...f.triedOn(A)]).toEqual(['menu'])
    expect([...f.triedOn(B)]).toEqual(['title', 'field'])
    // Only what changed nothing at all is dead (typing into a field changes the tree).
    expect([...f.deadOn(B)]).toEqual(['title'])
    expect(f.triedOn(C).size).toBe(0)
  })

  it('counts depth from the last app open; Back goes up one; a restart starts a segment', () => {
    const f = new Frontier()
    f.record({ from: A, to: B, key: 'x', treeChanged: true })
    f.record({ from: B, to: C, key: 'y', treeChanged: true })
    expect(f.depth).toBe(2)
    expect(f.overDepth(2)).toBe(true)
    f.record({ from: C, to: B, back: true, treeChanged: true })
    expect(f.depth).toBe(1)
    f.restarted()
    expect([f.segment, f.depth]).toEqual([2, 0])
    // What was tried stays known after a restart.
    expect([...f.triedOn(A)]).toEqual(['x'])
  })

  it('gets unstuck with Back first, then a restart', () => {
    const f = new Frontier()
    for (let i = 0; i < STUCK_AFTER - 1; i += 1) {
      f.record({ from: A, to: A, key: `k${i}`, treeChanged: false })
    }
    expect(f.stuck({ appRunning: true, appInFront: true })).toBeUndefined()
    f.record({ from: A, to: A, key: 'k9', treeChanged: false })
    expect(f.stuck({ appRunning: true, appInFront: true })).toBe('back')
    f.backedOut()
    for (let i = 0; i < STUCK_AFTER; i += 1) f.record({ from: A, to: A, treeChanged: false })
    expect(f.stuck({ appRunning: true, appInFront: true })).toBe('restart_app')
    // A new screen clears it.
    f.record({ from: A, to: B, key: 'z', treeChanged: true })
    expect(f.stuck({ appRunning: true, appInFront: true })).toBeUndefined()
  })

  it('restarts an app that died and backs out of another app first', () => {
    const f = new Frontier()
    expect(f.stuck({ appRunning: false, appInFront: false })).toBe('restart_app')
    expect(f.stuck({ appRunning: true, appInFront: false })).toBe('back')
    f.backedOut()
    expect(f.stuck({ appRunning: true, appInFront: false })).toBe('restart_app')
  })
})
