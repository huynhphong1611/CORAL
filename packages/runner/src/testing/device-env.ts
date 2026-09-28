import { Adb } from '../drivers/android/adb'

/**
 * Settings of `pnpm test:device` (D21), read from the environment:
 * CORAL_ADB, CORAL_TEST_UDID (default: the only online device), CORAL_TEST_APK (installed first
 * when set), CORAL_TEST_APP (default Sauce Labs My Demo App, research R15).
 */
export async function deviceTestEnv() {
  const adb = new Adb(process.env.CORAL_ADB ?? 'adb')
  let udid = process.env.CORAL_TEST_UDID
  if (!udid) {
    const online = (await adb.devices()).filter((d) => d.state === 'device')
    if (online.length !== 1) {
      throw new Error(`set CORAL_TEST_UDID: ${online.length} online devices found`)
    }
    udid = online[0]?.udid ?? ''
  }
  return {
    adb,
    udid,
    appId: process.env.CORAL_TEST_APP ?? 'com.saucelabs.mydemoapp.android',
    apk: process.env.CORAL_TEST_APK,
  }
}
