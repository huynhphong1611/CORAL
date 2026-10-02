import { describe, expect, it } from 'vitest'
import { FakeDriver, el, windows } from './fake-driver'

const PKG = 'com.example'
const login = windows(
  PKG,
  el({
    class: 'android.widget.FrameLayout',
    bounds: [0, 0, 1080, 2400],
    children: [
      el({
        platform_id: `${PKG}:id/name`,
        class: 'android.widget.EditText',
        bounds: [60, 490, 960, 130],
      }),
      el({
        platform_id: `${PKG}:id/login`,
        text: 'Login',
        bounds: [60, 920, 960, 140],
        clickable: true,
      }),
    ],
  }),
)
const home = windows(PKG, el({ text: 'Products', bounds: [0, 0, 1080, 2400] }))
const dialog = windows(
  PKG,
  el({
    bounds: [0, 0, 1080, 2400],
    children: [el({ text: 'Login', bounds: [60, 920, 960, 140] })],
  }),
  el({
    package_or_bundle: 'com.google.android.permissioncontroller',
    bounds: [60, 900, 960, 800],
    children: [el({ text: 'Allow', bounds: [120, 1200, 840, 120], clickable: true })],
  }),
)

function driver() {
  return new FakeDriver({
    start: 'login',
    screens: {
      login: { frames: [login], taps: { [`${PKG}:id/login`]: 'home' } },
      home: { frames: [home], back: 'login' },
      dialog: { frames: [dialog], taps: { Allow: 'login' } },
    },
  })
}

describe('FakeDriver', () => {
  it('assigns index-path refs and bottom-most-first windows', () => {
    expect(login[0]?.children.map((n) => n.ref)).toEqual(['0.0', '0.1'])
    expect(dialog[1]?.package_or_bundle).toBe('com.google.android.permissioncontroller')
  })

  it('follows taps and back between screens', async () => {
    const d = driver()
    await d.launch(PKG)
    await d.tapAt({ x: 500, y: 990 })
    expect(d.current).toBe('home')
    await d.back()
    expect(d.current).toBe('login')
  })

  it('names the screen as the foreground activity of the app window', async () => {
    const d = driver()
    d.show('dialog')
    expect(await d.foregroundActivity()).toEqual({ package: PKG, activity: '.dialog' })
    await d.launch(PKG)
    expect(await d.foregroundActivity()).toEqual({ package: PKG, activity: '.login' })
    // Asking does not count as a call of the test (tests compare `calls`).
    expect(d.calls.map((c) => c.kind)).toEqual(['launch'])
  })

  it('hits the top-most window first', async () => {
    const d = driver()
    d.show('dialog')
    await d.tapAt({ x: 500, y: 1250 })
    expect(d.calls.at(-1)).toMatchObject({ kind: 'tap', node: { text: 'Allow' } })
    expect(d.current).toBe('login')
  })

  it('records typed text on the focused element', async () => {
    const d = driver()
    await d.tapAt({ x: 500, y: 550 })
    await d.type('Nguyễn Văn A')
    expect(d.typed.get('0.0')).toBe('Nguyễn Văn A')
  })

  it('plays animation frames then repeats the last one', async () => {
    const d = new FakeDriver({ start: 's', screens: { s: { frames: [login, home] } } })
    expect(await d.tree()).toBe(login)
    expect(await d.tree()).toBe(home)
    expect(await d.tree()).toBe(home)
  })
})
