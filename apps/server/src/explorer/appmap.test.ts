import { EMPTY_APPMAP, MAX_APPMAP_SCREENS, appMapSchema, type AppMap } from '@coral/shared'
import { describe, expect, it } from 'vitest'
import { freeScreenId, mergeAppMap, type SeenScreen } from './appmap'

const at = new Date('2026-10-01T08:00:00.000Z')
const fp = (c: string) => c.repeat(16)
const seen = (fingerprint: string, name: string, id = ''): SeenScreen => ({
  fingerprint,
  id,
  name,
  package: 'com.saucelabs.mydemoapp.android',
  firstSeenAt: at,
})
const tap = (desc: string) => ({ action: 'tap' as const, target: [{ desc }] })

describe('mergeAppMap (contracts/appmap.md)', () => {
  it('adds new screens with slug ids and transitions between them', () => {
    const { map, ids, added, full } = mergeAppMap(
      EMPTY_APPMAP,
      {
        screens: [seen(fp('a'), 'Danh sách sản phẩm'), seen(fp('b'), 'Menu')],
        transitions: [{ from: fp('a'), to: fp('b'), action: tap('View menu') }],
      },
      'e1',
    )
    expect(map.screens.map((s) => [s.id, s.snapshot, s.seen_in])).toEqual([
      ['danh-sach-san-pham', 'appmap/snap/danh-sach-san-pham', ['e1']],
      ['menu', 'appmap/snap/menu', ['e1']],
    ])
    expect(map.transitions).toEqual([
      { from: 'danh-sach-san-pham', to: 'menu', action: tap('View menu'), seen_in: ['e1'] },
    ])
    expect(ids.get(fp('b'))).toBe('menu')
    expect(added).toHaveLength(2)
    expect(full).toBe(false)
    expect(appMapSchema.safeParse(map).success).toBe(true)
  })

  it('keeps id, name and snapshot of a known screen and only adds seen_in', () => {
    const first = mergeAppMap(
      EMPTY_APPMAP,
      { screens: [seen(fp('a'), 'Catalog')], transitions: [] },
      'e1',
    )
    const second = mergeAppMap(
      first.map,
      {
        screens: [seen(fp('a'), 'Products page', 'products-page'), seen(fp('c'), 'Catalog')],
        transitions: [
          { from: fp('a'), to: fp('c'), action: tap('Next') },
          { from: fp('a'), to: fp('c'), action: tap('Next') },
        ],
      },
      'e2',
    )
    expect(second.map.screens.map((s) => [s.id, s.name, s.seen_in])).toEqual([
      ['catalog', 'Catalog', ['e1', 'e2']],
      // Same name, other screen: the next free id.
      ['catalog-2', 'Catalog', ['e2']],
    ])
    expect(second.ids.get(fp('a'))).toBe('catalog')
    expect(second.added.map((s) => s.id)).toEqual(['catalog-2'])
    expect(second.map.transitions).toHaveLength(1)
    // The same transition seen by a third exploration only gains seen_in.
    const third = mergeAppMap(
      second.map,
      {
        screens: [seen(fp('a'), 'x'), seen(fp('c'), 'y')],
        transitions: [{ from: fp('a'), to: fp('c'), action: tap('Next') }],
      },
      'e3',
    )
    expect(third.map.transitions[0]?.seen_in).toEqual(['e2', 'e3'])
  })

  it('stops adding screens at the limit', () => {
    const base: AppMap = {
      ...EMPTY_APPMAP,
      screens: Array.from({ length: MAX_APPMAP_SCREENS }, (_, i) => ({
        id: `s-${i}`,
        name: `S ${i}`,
        fingerprint: i.toString(16).padStart(16, '0'),
        package: 'p.q',
        snapshot: `appmap/snap/s-${i}`,
        first_seen_at: at.toISOString(),
        seen_in: [],
      })),
    }
    const result = mergeAppMap(base, { screens: [seen(fp('f'), 'New')], transitions: [] }, 'e9')
    expect(result.full).toBe(true)
    expect(result.map.screens).toHaveLength(MAX_APPMAP_SCREENS)
  })

  it('finds a free id with a suffix and keeps it at 50 characters', () => {
    const long = 'x'.repeat(60)
    expect(freeScreenId(new Set(), long)).toHaveLength(50)
    const taken = new Set(['x'.repeat(50)])
    const id = freeScreenId(taken, long)
    expect(id.endsWith('-2')).toBe(true)
    expect(id.length).toBeLessThanOrEqual(50)
    expect(freeScreenId(new Set(['menu']), 'Menu', 'menu-x')).toBe('menu-x')
  })
})
