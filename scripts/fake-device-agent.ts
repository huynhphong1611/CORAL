// Test helper for scripts/*.int.test.ts: the real coral-agent code driving a FakeDriver that
// plays a login screen (id/user + "Login") leading to a home screen ("Products"). With
// `permissionPopup`, a runtime-permission dialog covers the login screen after every launch.
// `sampleAppDriver` is the drawn My Demo App look-alike instead (scripts/dev-fake-device.ts, E2E,
// scripts/phase3-dod.int.test.ts): real pictures, so the Explorer can look at it.
import { FakeClock, FakeDriver, el, sampleApp, windows } from '@coral/runner/testing'
import { startAgent } from '../apps/agent/src/agent'

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
    // A fresh fake device per job, as before sessions were shared.
    sessionIdleMs: 0,
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
        }),
      )
    },
  })
  return { agent, drivers }
}

/** A driver of the drawn My Demo App look-alike, typed text shown on screen. */
export function sampleAppDriver() {
  const driver = new FakeDriver({
    ...sampleApp(),
    showTyped: true,
    renderScreens: { scale: 0.5 },
  })
  return Object.assign(driver, {
    open: () => Promise.resolve(),
    close: () => Promise.resolve(),
    forApp: () => driver,
  })
}

/** The real agent code with one device, the drawn My Demo App: explores, records and runs. */
export function startSampleDeviceAgent(input: {
  serverUrl: string
  token: string
  cacheDir: string
  udid?: string
}) {
  return startAgent({
    wsUrl: `${input.serverUrl.replace(/^http/, 'ws')}/ws/agent`,
    token: input.token,
    cacheDir: input.cacheDir,
    minBackoffMs: 50,
    devicePollMs: 60_000,
    source: {
      list: () => Promise.resolve([{ udid: input.udid ?? 'fake-mydemo-1', state: 'device' }]),
      props: () =>
        Promise.resolve({
          model: 'coral fake (My Demo App)',
          osVersion: '14',
          apiLevel: 34,
          emulator: true,
        }),
    },
    createDriver: () => Promise.resolve(sampleAppDriver()),
  })
}
