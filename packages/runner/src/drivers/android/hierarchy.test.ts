import { elementTreeSchema, walkTree } from '@coral/shared'
import { describe, expect, it } from 'vitest'
import { ANDROID_FIXTURES, APP, androidTree } from '../../testing/android-fixtures'
import { matchWindowLayers, parseHierarchy, parseWindowLayers, windowOrder } from './hierarchy'

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

// Trimmed `dumpsys window windows` from the CI Android 14 emulator, camera permission dialog open.
const DUMPSYS_14 = `WINDOW MANAGER WINDOWS (dumpsys window windows)
  Window #0 Window{829de41 u0 ScreenDecorOverlayBottom}:
    mDisplayId=0 rootTaskId=1 mSession=Session{a 1234:u0a10120} mClient=android.os.BinderProxy@1
    mOwnerUid=10120 showForAllUsers=true package=com.android.systemui appop=NONE
    Frames: parent=[0,2274][1080,2400] display=[0,2274][1080,2400] frame=[0,2274][1080,2400] last=[0,2274][1080,2400] insetsChanged=false
  Window #1 Window{9ef7b58 u0 StatusBar}:
    mOwnerUid=10120 showForAllUsers=true package=com.android.systemui appop=NONE
    Frames: parent=[0,0][1080,128] display=[0,0][1080,128] frame=[0,0][1080,128] last=[0,0][1080,128] insetsChanged=false
  Window #2 Window{ee4ee0c u0 InputMethod}:
    mOwnerUid=10133 showForAllUsers=false package=com.google.android.inputmethod.latin appop=NONE
    Frames: parent=[0,1517][1080,2400] display=[0,1517][1080,2400] frame=[0,1517][1080,2400] last=[0,1517][1080,2400] insetsChanged=false
  Window #3 Window{4d0ddca u0 com.google.android.permissioncontroller/com.android.permissioncontroller.permission.ui.GrantPermissionsActivity}:
    mOwnerUid=10151 showForAllUsers=false package=com.google.android.permissioncontroller appop=NONE
    Frames: parent=[0,0][1080,2400] display=[0,0][1080,2400] frame=[28,746][1052,1718] last=[28,746][1052,1718] insetsChanged=false
  Window #4 Window{3a9bb36 u0 com.saucelabs.mydemoapp.android/com.saucelabs.mydemoapp.android.view.activities.MainActivity}:
    mOwnerUid=10190 showForAllUsers=false package=com.saucelabs.mydemoapp.android appop=NONE
    Frames: parent=[0,0][1080,2400] display=[0,0][1080,2400] frame=[0,0][1080,2400] last=[0,0][1080,2400] insetsChanged=false
  Window #5 Window{20183f4 u0 com.android.systemui.wallpapers.ImageWallpaper}:
    mOwnerUid=10120 showForAllUsers=true package=com.android.systemui appop=NONE
    Frames: parent=[0,0][1080,2400] display=[0,0][1080,2400] frame=[0,0][1080,2400] last=[0,0][1080,2400] insetsChanged=false

  mGlobalConfiguration={1.0 ?mcc?mnc [en_US] package=com.example.not.a.window}
  mCurrentFocus=Window{4d0ddca u0 com.google.android.permissioncontroller/com.android.permissioncontroller.permission.ui.GrantPermissionsActivity}
`

// Android 10 and older: "mFrame=", and no package= line on some windows.
const DUMPSYS_OLD = `  Window #0 Window{1a2b3c u0 StatusBar}:
    mOwnerUid=10020 showForAllUsers=true package=com.android.systemui appop=NONE
    mFrame=[0,0][1080,63] last=[0,0][1080,63]
  Window #1 Window{4d5e6f u0 com.example.app/com.example.app.Main}:
    mFrame=[0,0][1080,1920] last=[0,0][1080,1920]
`

const APP_ID = 'com.saucelabs.mydemoapp.android'
const node = (pkg: string, [x1, y1, x2, y2]: number[]) =>
  `<node class="android.widget.FrameLayout" package="${pkg}" bounds="[${x1},${y1}][${x2},${y2}]"/>`
const STATUS = node('com.android.systemui', [0, 0, 1080, 128])
const DIALOG = node('com.google.android.permissioncontroller', [28, 746, 1052, 1718])
const KEYS = node('com.google.android.inputmethod.latin', [0, 1517, 1080, 2400])
const APP_WINDOW = node(APP_ID, [0, 0, 1080, 2400])
const packages = (tree: { package_or_bundle: string }[]) => tree.map((w) => w.package_or_bundle)

describe('window order (research R5)', () => {
  it('reads the window manager z-order, top-most first, with package and frame', () => {
    expect(parseWindowLayers(DUMPSYS_14)).toEqual([
      { package: 'com.android.systemui', frame: { x: 0, y: 2274, w: 1080, h: 126 } },
      { package: 'com.android.systemui', frame: { x: 0, y: 0, w: 1080, h: 128 } },
      {
        package: 'com.google.android.inputmethod.latin',
        frame: { x: 0, y: 1517, w: 1080, h: 883 },
      },
      {
        package: 'com.google.android.permissioncontroller',
        frame: { x: 28, y: 746, w: 1024, h: 972 },
      },
      { package: APP_ID, frame: { x: 0, y: 0, w: 1080, h: 2400 } },
      { package: 'com.android.systemui', frame: { x: 0, y: 0, w: 1080, h: 2400 } },
    ])
    expect(parseWindowLayers(DUMPSYS_OLD)).toEqual([
      { package: 'com.android.systemui', frame: { x: 0, y: 0, w: 1080, h: 63 } },
      { package: 'com.example.app', frame: { x: 0, y: 0, w: 1080, h: 1920 } },
    ])
    expect(parseWindowLayers('')).toEqual([])
  })

  it('orders windows by the window manager whatever order u2 dumped them in', () => {
    const layers = parseWindowLayers(DUMPSYS_14)
    // u2 collects window roots in a HashSet: any order can come out.
    const scrambled = `<hierarchy>${DIALOG}${STATUS}${APP_WINDOW}${KEYS}</hierarchy>`
    const tree = parseHierarchy(scrambled, layers)
    expect(packages(tree)).toEqual([
      APP_ID,
      'com.google.android.permissioncontroller',
      'com.google.android.inputmethod.latin',
      'com.android.systemui',
    ])
    expect(tree.map((w) => w.ref)).toEqual(['0', '1', '2', '3'])
    expect(tree[1]?.android?.window_index).toBe(1)
  })

  it('matches a window to the layer with its frame, not just its package', () => {
    const layers = parseWindowLayers(DUMPSYS_14)
    // The status bar is layer 1 (frame [0,0][1080,128]), not the screen decor above it.
    expect(
      matchWindowLayers(
        [{ package: 'com.android.systemui', bounds: { x: 0, y: 0, w: 1080, h: 128 } }],
        layers,
      ),
    ).toEqual([1])
    // Accessibility bounds clipped inside the frame still match it.
    expect(
      matchWindowLayers([{ package: APP_ID, bounds: { x: 0, y: 128, w: 1080, h: 2146 } }], layers),
    ).toEqual([4])
    expect(
      matchWindowLayers([{ package: 'com.other', bounds: { x: 0, y: 0, w: 1, h: 1 } }], layers),
    ).toBeUndefined()
  })

  it('falls back to window classes when the window manager has no layer for a window', () => {
    // No layers at all (fixtures), or a dialog that appeared between the two reads.
    const withoutDialog = parseWindowLayers(DUMPSYS_14).filter((l) => !/permission/.test(l.package))
    for (const layers of [undefined, withoutDialog]) {
      const tree = parseHierarchy(
        `<hierarchy>${STATUS}${KEYS}${DIALOG}${APP_WINDOW}</hierarchy>`,
        layers,
      )
      expect(packages(tree)).toEqual([
        APP_ID,
        'com.google.android.permissioncontroller',
        'com.google.android.inputmethod.latin',
        'com.android.systemui',
      ])
    }
    // Same class and size: dump order is kept.
    const twin = { package: 'a.b', bounds: { x: 0, y: 0, w: 10, h: 10 } }
    expect(windowOrder([twin, { ...twin, package: 'c.d' }])).toEqual([0, 1])
  })
})
