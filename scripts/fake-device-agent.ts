// Test helper for scripts/*.int.test.ts: the real coral-agent code driving a FakeDriver that
// plays a login screen (id/user + "Login") leading to a home screen ("Products"). With
// `permissionPopup`, a runtime-permission dialog covers the login screen after every launch.
import { FakeClock, FakeDriver, el, windows } from '@coral/runner/testing'
import { startAgent } from '../apps/agent/src/agent'
import type { RunnableDriver } from '../apps/agent/src/jobs'

export const FAKE_APP = 'com.example.app'

const loginWindow = el({
  bounds: [0, 0, 1080, 2400],
  children: [
    el({
      platform_id: `${FAKE_APP}:id/user`,
      class: 'android.widget.EditText',
      clickable: true,
      bounds: [100, 100, 800, 120],
    }),
    el({
      text: 'Login',
      class: 'android.widget.Button',
      clickable: true,
      bounds: [100, 300, 800, 120],
    }),
  ],
})
const login = windows(FAKE_APP, loginWindow)
const PERMISSION = 'com.google.android.permissioncontroller'
const permission = windows(
  FAKE_APP,
  loginWindow,
  el({
    package_or_bundle: PERMISSION,
    bounds: [0, 0, 1080, 2400],
    children: [
      el({ text: 'Allow app to send you notifications?', bounds: [120, 960, 840, 160] }),
      el({
        text: 'Allow',
        class: 'android.widget.Button',
        clickable: true,
        bounds: [120, 1200, 840, 120],
      }),
      el({
        text: 'Don’t allow',
        class: 'android.widget.Button',
        clickable: true,
        bounds: [120, 1340, 840, 120],
      }),
    ],
  }),
)
const home = windows(
  FAKE_APP,
  el({
    bounds: [0, 0, 1080, 2400],
    children: [el({ text: 'Products', bounds: [0, 100, 1080, 100] })],
  }),
)

export function startFakeDeviceAgent(input: {
  serverUrl: string
  token: string
  cacheDir: string
  udid?: string
  permissionPopup?: boolean
}) {
  const drivers: FakeDriver[] = []
  const agent = startAgent({
    wsUrl: `${input.serverUrl.replace(/^http/, 'ws')}/ws/agent`,
    token: input.token,
    cacheDir: input.cacheDir,
    clock: new FakeClock(),
    minBackoffMs: 50,
    source: {
      list: () => Promise.resolve([{ udid: input.udid ?? 'emulator-5554', state: 'device' }]),
      props: () =>
        Promise.resolve({ model: 'sdk_gphone64', osVersion: '14', apiLevel: 34, emulator: true }),
    },
    createDriver: () => {
      const driver = new FakeDriver({
        screens: {
          permission: { frames: [permission], taps: { Allow: 'login' } },
          login: { frames: [login], taps: { Login: 'home' } },
          home: { frames: [home] },
        },
        start: input.permissionPopup ? 'permission' : 'login',
      })
      drivers.push(driver)
      return Promise.resolve(
        Object.assign(driver, {
          open: () => Promise.resolve(),
          close: () => Promise.resolve(),
        }) as unknown as RunnableDriver,
      )
    },
  })
  return { agent, drivers }
}
