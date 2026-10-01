import { describe, expect, it } from 'vitest'
import type { ElementNode } from '../element'
import { screenFingerprint } from './fingerprint'
import { sha256Hex } from './sha256'

const APP = 'com.example.shop'
let refs = 0
function node(
  cls: string,
  id = '',
  options: Partial<ElementNode> = {},
  children: ElementNode[] = [],
): ElementNode {
  refs += 1
  return {
    ref: String(refs),
    platform_id: id ? `${APP}:id/${id}` : '',
    text: '',
    desc: '',
    class: `android.widget.${cls}`,
    bounds: { x: 0, y: refs, w: 100, h: 10 },
    clickable: false,
    enabled: true,
    visible: true,
    package_or_bundle: APP,
    children,
    ...options,
  }
}
const statusBar = (clock: string) => ({
  ...node('FrameLayout', '', {}, [node('TextView', '', { text: clock })]),
  package_or_bundle: 'com.android.systemui',
})
function catalog(items: string[], clock = '10:24'): ElementNode[] {
  const rows = items.map((name) => node('TextView', 'itemTV', { text: name, clickable: true }))
  return [
    statusBar(clock),
    node('FrameLayout', '', {}, [
      node('ImageView', 'menuIV', { clickable: true, desc: 'View menu' }),
      node('RecyclerView', 'productRV', {}, rows),
    ]),
  ]
}

describe('sha256Hex', () => {
  it('matches known digests', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(sha256Hex('Đăng nhập'.repeat(20))).toHaveLength(64)
  })
})

describe('screenFingerprint (D24)', () => {
  const ctx = { package: APP, activity: '.MainActivity' }

  it('is 16 hex characters', () => {
    expect(screenFingerprint(catalog(['A']), ctx)).toMatch(/^[0-9a-f]{16}$/)
  })

  it('ignores text, list length and the status bar', () => {
    const a = screenFingerprint(catalog(['Backpack', 'Bike light', 'Bolt T-shirt']), ctx)
    const b = screenFingerprint(catalog(['Onesie', 'Jacket'], '23:59'), ctx)
    expect(a).toBe(b)
  })

  it('tells different screens apart', () => {
    const login = [
      node('FrameLayout', '', {}, [
        node('EditText', 'nameET', { clickable: true }),
        node('Button', 'loginBtn', { clickable: true }),
      ]),
    ]
    expect(screenFingerprint(login, ctx)).not.toBe(screenFingerprint(catalog(['A']), ctx))
  })

  it('takes the activity and the app into account', () => {
    const tree = catalog(['A'])
    expect(screenFingerprint(tree, ctx)).not.toBe(
      screenFingerprint(tree, { ...ctx, activity: '.DetailActivity' }),
    )
    // Without the app's package, only system windows are left out.
    expect(screenFingerprint(tree)).toBe(screenFingerprint(catalog(['B'], '01:00')))
  })

  it('ignores invisible elements and a keyboard window', () => {
    const tree = catalog(['A'])
    const keyboard = {
      ...node('FrameLayout', '', {}, [node('Button', 'key_a', { clickable: true })]),
      package_or_bundle: 'com.google.android.inputmethod.latin',
    }
    const hidden = node('Button', 'secretBtn', { clickable: true, visible: false })
    const [bar, app] = tree
    const withExtras = [bar!, { ...app!, children: [...app!.children, hidden] }, keyboard]
    expect(screenFingerprint(withExtras)).toBe(screenFingerprint(tree))
  })
})
