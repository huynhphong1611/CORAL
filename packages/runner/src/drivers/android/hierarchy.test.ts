import { elementTreeSchema, walkTree } from '@coral/shared'
import { describe, expect, it } from 'vitest'
import { ANDROID_FIXTURES, APP, androidTree } from '../../testing/android-fixtures'
import { parseHierarchy } from './hierarchy'

describe('parseHierarchy', () => {
  it('finds every fixture', () => {
    expect(ANDROID_FIXTURES).toHaveLength(9)
  })

  it.each(ANDROID_FIXTURES)('turns %s into a valid tree.json', (file) => {
    const tree = androidTree(file.replace(/\.xml$/, ''))
    expect(elementTreeSchema.safeParse(tree).success).toBe(true)
    expect(tree.length).toBeGreaterThanOrEqual(2)
    // Status bar window is last in every fixture (README).
    expect(tree.at(-1)?.package_or_bundle).toBe('com.android.systemui')
    for (const node of walkTree(tree)) {
      expect(node.bounds.w).toBeGreaterThanOrEqual(0)
      expect(node.android?.window_index).toBe(Number(node.ref.split('.')[0]))
    }
  })

  it('maps attributes, bounds and index-path refs', () => {
    const tree = androidTree('login')
    const name = [...walkTree(tree)].find((n) => n.platform_id === `${APP}:id/nameET`)
    expect(name).toMatchObject({
      ref: '0.0.0.2',
      desc: 'Tên đăng nhập',
      class: 'android.widget.EditText',
      bounds: { x: 60, y: 490, w: 960, h: 130 },
      clickable: true,
      enabled: true,
      visible: true,
      package_or_bundle: APP,
      android: { password: false, focused: false, drawing_order: 3, window_index: 0 },
    })
    const password = [...walkTree(tree)].find((n) => n.platform_id.endsWith('passwordET'))
    expect(password?.android?.password).toBe(true)
    expect([...walkTree(tree)].find((n) => n.platform_id.endsWith(':id/clock'))?.text).toBe('10:24')
  })

  it('keeps visible-to-user=false and infers visibility when the attribute is missing', () => {
    const hidden = [...walkTree(androidTree('list-scroll'))].filter((n) => !n.visible)
    expect(hidden.length).toBeGreaterThan(0)
    const [win] = parseHierarchy(
      '<hierarchy><node class="a" bounds="[0,0][10,10]"><node class="b" bounds="[5,5][5,9]"/></node></hierarchy>',
    )
    expect(win?.visible).toBe(true)
    expect(win?.children[0]?.visible).toBe(false)
  })

  it('returns no windows for an empty dump', () => {
    expect(parseHierarchy('<hierarchy rotation="0"></hierarchy>')).toEqual([])
  })
})
