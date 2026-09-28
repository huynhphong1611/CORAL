import { describe, expect, it } from 'vitest'
import { Adb, AdbError, parseDevices, type ExecFn } from './adb'

const DEVICES = `List of devices attached
emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1
R58M123ABC             unauthorized usb:1-1 transport_id:2
192.168.1.20:5555      offline

`

function fakeAdb(responses: Record<string, string>) {
  const calls: string[][] = []
  const exec: ExecFn = (file, args) => {
    calls.push([file, ...args])
    const key = args.join(' ')
    const out = responses[key]
    return out === undefined
      ? Promise.reject(new AdbError(`unexpected: ${key}`))
      : Promise.resolve(Buffer.from(out))
  }
  return { adb: new Adb('/opt/adb', exec), calls }
}

describe('adb', () => {
  it('parses devices -l', () => {
    expect(parseDevices(DEVICES)).toEqual([
      { udid: 'emulator-5554', state: 'device', model: 'sdk_gphone64_x86_64', transportId: '1' },
      { udid: 'R58M123ABC', state: 'unauthorized', transportId: '2' },
      { udid: '192.168.1.20:5555', state: 'offline' },
    ])
    expect(parseDevices('List of devices attached\n\n')).toEqual([])
  })

  it('reads device props and recognises emulators', async () => {
    const props = (serial: string, qemu: string) => ({
      [`-s ${serial} shell getprop ro.product.model`]: 'Pixel 7\n',
      [`-s ${serial} shell getprop ro.build.version.release`]: '14\n',
      [`-s ${serial} shell getprop ro.build.version.sdk`]: '34\n',
      [`-s ${serial} shell getprop ro.kernel.qemu`]: `${qemu}\n`,
      [`-s ${serial} shell getprop ro.build.characteristics`]: 'phone\n',
    })
    const { adb, calls } = fakeAdb({ ...props('emulator-5554', ''), ...props('R58M', '') })
    expect(await adb.device('emulator-5554').props()).toEqual({
      model: 'Pixel 7',
      osVersion: '14',
      apiLevel: 34,
      emulator: true,
    })
    expect((await adb.device('R58M').props()).emulator).toBe(false)
    expect(calls[0]?.[0]).toBe('/opt/adb')
  })

  it('builds per-device commands without a local shell', async () => {
    const { adb, calls } = fakeAdb({
      '-s emu shell pm clear com.x': 'Success',
      '-s emu exec-out screencap -p': 'xPNG',
      '-s emu install -r -d /tmp/app.apk': 'Success',
      '-s emu forward tcp:0 tcp:9008': '41234\n',
    })
    const device = adb.device('emu')
    await device.shell(['pm', 'clear', 'com.x'])
    expect((await device.execOut(['screencap', '-p'])).subarray(1).toString()).toBe('PNG')
    await device.install('/tmp/app.apk')
    expect(await device.forwardAny(9008)).toBe(41234)
    expect(calls.map((c) => c.slice(1).join(' '))).toContain('-s emu install -r -d /tmp/app.apk')
  })

  it('surfaces adb failures', async () => {
    const { adb } = fakeAdb({})
    await expect(adb.devices()).rejects.toBeInstanceOf(AdbError)
  })
})
