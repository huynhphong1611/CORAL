import { describe, expect, it } from 'vitest'
import { appMapSchema, screenSlug, EMPTY_APPMAP } from './schema'

const screen = (id: string, fingerprint: string) => ({
  id,
  name: id,
  fingerprint,
  package: 'com.example.shop',
  snapshot: `appmap/snap/${id}`,
  first_seen_at: '2026-10-01T08:00:00Z',
})

describe('appMapSchema', () => {
  const map = {
    schema: 'coral/appmap@1',
    screens: [screen('catalog', 'aaaaaaaaaaaaaaaa'), screen('menu', 'bbbbbbbbbbbbbbbb')],
    transitions: [
      {
        from: 'catalog',
        to: 'menu',
        action: { action: 'tap', target: [{ android_id: 'id/menuIV' }, { desc: 'View menu' }] },
      },
    ],
  }

  it('accepts an app map and fills seen_in', () => {
    const parsed = appMapSchema.parse(map)
    expect(parsed.screens[0]?.seen_in).toEqual([])
    expect(appMapSchema.parse(EMPTY_APPMAP)).toEqual(EMPTY_APPMAP)
  })

  it('rejects duplicate ids or fingerprints, unknown screens and steps with an id', () => {
    const bad = (value: unknown) => appMapSchema.safeParse(value).success
    expect(bad({ ...map, screens: [map.screens[0], map.screens[0]] })).toBe(false)
    expect(bad({ ...map, screens: [map.screens[0], screen('other', 'aaaaaaaaaaaaaaaa')] })).toBe(
      false,
    )
    expect(bad({ ...map, transitions: [{ ...map.transitions[0], to: 'nowhere' }] })).toBe(false)
    expect(
      bad({
        ...map,
        transitions: [{ ...map.transitions[0], action: { id: 's1', action: 'back' } }],
      }),
    ).toBe(false)
    expect(
      bad({ ...map, transitions: [{ ...map.transitions[0], action: { action: 'tap' } }] }),
    ).toBe(false)
  })
})

describe('screenSlug', () => {
  it('makes ASCII ids from Vietnamese names', () => {
    expect(screenSlug('Danh sách sản phẩm')).toBe('danh-sach-san-pham')
    expect(screenSlug('Đăng nhập')).toBe('dang-nhap')
    expect(screenSlug('!!!')).toBe('screen')
    expect(screenSlug('x'.repeat(80))).toHaveLength(50)
  })
})
