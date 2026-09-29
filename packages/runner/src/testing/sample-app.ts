import type { ElementNode } from '@coral/shared'
import { el, windows, type FakeDriverOptions } from './fake-driver'

/** Package of the Sauce Labs My Demo App (research R15), mimicked by the fake screens below. */
export const SAMPLE_APP = 'com.saucelabs.mydemoapp.android'
const id = (name: string) => `${SAMPLE_APP}:id/${name}`
const SYSTEM_UI = 'com.android.systemui'
const PERMISSION = 'com.google.android.permissioncontroller'

const statusBar = el({
  package_or_bundle: SYSTEM_UI,
  bounds: [0, 0, 1080, 100],
  children: [
    el({
      package_or_bundle: SYSTEM_UI,
      platform_id: `${SYSTEM_UI}:id/clock`,
      text: '10:24',
      bounds: [40, 20, 160, 60],
    }),
  ],
})

const header = [
  el({
    platform_id: id('menuIV'),
    desc: 'View menu',
    class: 'android.widget.ImageView',
    clickable: true,
    bounds: [24, 110, 110, 110],
  }),
  el({
    platform_id: id('mTvTitle'),
    text: 'MY DEMO APP',
    class: 'android.widget.TextView',
    bounds: [380, 120, 320, 90],
  }),
  el({
    platform_id: id('cartIV'),
    desc: 'Displays number of items in your cart',
    class: 'android.widget.ImageView',
    clickable: true,
    bounds: [946, 110, 110, 110],
  }),
]

const products = [
  'Sauce Labs Backpack',
  'Sauce Labs Backpack (green)',
  'Sauce Labs Backpack (orange)',
  'Sauce Labs Backpack (red)',
]

function catalogChildren() {
  return [
    ...header,
    el({
      platform_id: id('productTV'),
      text: 'Products',
      class: 'android.widget.TextView',
      bounds: [40, 260, 600, 90],
    }),
    ...products.map((name, i) =>
      el({
        platform_id: id('productIV'),
        desc: 'Product Image',
        class: 'android.view.ViewGroup',
        clickable: true,
        bounds: [40 + (i % 2) * 520, 380 + Math.floor(i / 2) * 760, 480, 700],
        children: [
          el({
            platform_id: id('titleTV'),
            text: name,
            class: 'android.widget.TextView',
            bounds: [60 + (i % 2) * 520, 900 + Math.floor(i / 2) * 760, 440, 70],
          }),
          el({
            platform_id: id('priceTV'),
            text: '$ 29.99',
            class: 'android.widget.TextView',
            bounds: [60 + (i % 2) * 520, 980 + Math.floor(i / 2) * 760, 440, 70],
          }),
        ],
      }),
    ),
  ]
}

const appWindow = (children: ReturnType<typeof el>[]) =>
  el({ bounds: [0, 0, 1080, 2400], children })

const MENU_ITEMS = [
  'Catalog',
  'WebView',
  'QR Code Scanner',
  'Geo Location',
  'Drawing',
  'About',
  'Reset App State',
  'FingerPrint',
  'Virtual USB',
  'Log In',
]

const drawer = el({
  platform_id: id('menuRV'),
  class: 'androidx.recyclerview.widget.RecyclerView',
  bounds: [0, 100, 700, 2300],
  android: { password: false, focused: false, scrollable: true, drawing_order: 9, window_index: 0 },
  children: MENU_ITEMS.map((text, i) =>
    el({
      platform_id: id('itemTV'),
      text,
      class: 'android.widget.TextView',
      clickable: true,
      bounds: [0, 140 + i * 130, 700, 120],
    }),
  ),
})

const loginChildren = [
  ...header,
  el({
    platform_id: id('loginTV'),
    text: 'Login',
    class: 'android.widget.TextView',
    bounds: [40, 260, 600, 90],
  }),
  el({
    platform_id: id('usernameTV'),
    text: 'Username',
    class: 'android.widget.TextView',
    bounds: [40, 410, 600, 60],
  }),
  el({
    platform_id: id('nameET'),
    class: 'android.widget.EditText',
    clickable: true,
    bounds: [40, 480, 1000, 130],
  }),
  el({
    platform_id: id('passwordTV'),
    text: 'Password',
    class: 'android.widget.TextView',
    bounds: [40, 650, 600, 60],
  }),
  el({
    platform_id: id('passwordET'),
    class: 'android.widget.EditText',
    clickable: true,
    bounds: [40, 720, 1000, 130],
    android: {
      password: true,
      focused: false,
      scrollable: false,
      drawing_order: 0,
      window_index: 0,
    },
  }),
  el({
    platform_id: id('loginBtn'),
    text: 'Login',
    class: 'android.widget.Button',
    clickable: true,
    bounds: [40, 920, 1000, 140],
  }),
  el({
    platform_id: id('username1TV'),
    text: 'bod@example.com',
    class: 'android.widget.TextView',
    bounds: [40, 1160, 700, 60],
  }),
]

const qrChildren = [
  ...header,
  el({
    platform_id: id('qrTV'),
    text: 'QR Code Scanner',
    class: 'android.widget.TextView',
    bounds: [40, 260, 700, 90],
  }),
  el({
    platform_id: id('scannerView'),
    class: 'android.view.SurfaceView',
    bounds: [0, 380, 1080, 1800],
  }),
]

const permissionDialog = el({
  package_or_bundle: PERMISSION,
  bounds: [28, 746, 1024, 972],
  children: [
    el({
      package_or_bundle: PERMISSION,
      platform_id: `${PERMISSION}:id/permission_message`,
      text: 'Allow My Demo App to take pictures and record video?',
      bounds: [88, 800, 904, 180],
    }),
    el({
      package_or_bundle: PERMISSION,
      platform_id: `${PERMISSION}:id/permission_allow_foreground_only_button`,
      text: 'While using the app',
      class: 'android.widget.Button',
      clickable: true,
      bounds: [88, 1010, 904, 130],
    }),
    el({
      package_or_bundle: PERMISSION,
      platform_id: `${PERMISSION}:id/permission_allow_one_time_button`,
      text: 'Only this time',
      class: 'android.widget.Button',
      clickable: true,
      bounds: [88, 1160, 904, 130],
    }),
    el({
      package_or_bundle: PERMISSION,
      platform_id: `${PERMISSION}:id/permission_deny_button`,
      text: 'Don’t allow',
      class: 'android.widget.Button',
      clickable: true,
      bounds: [88, 1310, 904, 130],
    }),
  ],
})

/** Screens as windows, bottom-most first; the status bar always on top. */
const screen = (...app: ReturnType<typeof el>[]): ElementNode[] =>
  windows(SAMPLE_APP, ...app, statusBar)

/**
 * A scripted look-alike of My Demo App for FakeDriver: catalog → menu → login → products, and the
 * QR scanner behind a camera permission dialog. fixtures/testcases/mydemo-*.yaml pass on it, so
 * E2E tests, the live view and the Recorder work without an emulator.
 */
export function sampleApp(): Pick<FakeDriverOptions, 'screens' | 'start'> {
  return {
    start: 'catalog',
    screens: {
      catalog: { frames: [screen(appWindow(catalogChildren()))], taps: { [id('menuIV')]: 'menu' } },
      menu: {
        frames: [screen(appWindow([...catalogChildren(), drawer]))],
        taps: { Catalog: 'catalog', 'Log In': 'login', 'QR Code Scanner': 'qr_permission' },
        back: 'catalog',
      },
      login: {
        frames: [screen(appWindow(loginChildren))],
        taps: { [id('loginBtn')]: 'catalog', [id('menuIV')]: 'menu' },
        back: 'catalog',
      },
      qr_permission: {
        frames: [screen(appWindow(qrChildren), permissionDialog)],
        taps: { 'While using the app': 'qr', 'Only this time': 'qr', 'Don’t allow': 'qr' },
      },
      qr: {
        frames: [screen(appWindow(qrChildren))],
        taps: { [id('menuIV')]: 'menu' },
        back: 'catalog',
      },
    },
  }
}
