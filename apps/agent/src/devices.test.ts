import { describe, expect, it } from 'vitest'
import { DeviceWatcher, type DeviceSource, type DeviceUpdate } from './devices'

function setup() {
  let listed: { udid: string; state: string }[] = []
  let propsCalls = 0
  const source: DeviceSource = {
    list: () => Promise.resolve(listed),
    props: (udid) => {
      propsCalls += 1
      return Promise.resolve({
        model: udid.startsWith('emulator') ? 'sdk_gphone64' : 'Pixel 7',
        osVersion: '14',
        apiLevel: 34,
        emulator: udid.startsWith('emulator'),
      })
    },
  }
  const busy = new Set<string>()
  const updates: DeviceUpdate[] = []
  const warnings: string[] = []
  const watcher = new DeviceWatcher({
    source,
    busy: (udid) => busy.has(udid),
    onUpdate: (u) => updates.push(u),
    log: {
      warn: (_o: unknown, msg?: string) => void warnings.push(msg ?? ''),
      info: () => undefined,
    },
  })
  return {
    watcher,
    updates,
    warnings,
    busy,
    set: (next: typeof listed) => (listed = next),
    propsCalls: () => propsCalls,
  }
}

describe('DeviceWatcher', () => {
  it('reports added, changed and removed devices', async () => {
    const t = setup()
    t.set([{ udid: 'emulator-5554', state: 'device' }])
    await t.watcher.poll()
    expect(t.updates.at(-1)).toEqual({
      added: [
        {
          udid: 'emulator-5554',
          platform: 'android',
          kind: 'emulator',
          model: 'sdk_gphone64',
          os_version: '14',
          api_level: 34,
          status: 'idle',
        },
      ],
      removed: [],
      changed: [],
    })

    await t.watcher.poll()
    expect(t.updates).toHaveLength(1)

    t.busy.add('emulator-5554')
    t.set([
      { udid: 'emulator-5554', state: 'device' },
      { udid: 'R58M', state: 'device' },
    ])
    await t.watcher.poll()
    expect(t.updates.at(-1)).toMatchObject({
      added: [{ udid: 'R58M', kind: 'real' }],
      changed: [{ udid: 'emulator-5554', status: 'busy' }],
    })
    expect(t.watcher.statuses()).toEqual([
      { udid: 'emulator-5554', status: 'busy' },
      { udid: 'R58M', status: 'idle' },
    ])

    t.set([{ udid: 'R58M', state: 'offline' }])
    await t.watcher.poll()
    expect(t.updates.at(-1)).toMatchObject({ removed: ['emulator-5554', 'R58M'] })
    expect(t.propsCalls()).toBe(2)
  })

  it('never reports unauthorized devices and warns only once', async () => {
    const t = setup()
    t.set([{ udid: 'R58M', state: 'unauthorized' }])
    await t.watcher.poll()
    await t.watcher.poll()
    expect(t.updates).toEqual([])
    expect(t.warnings.filter((w) => w.includes('unauthorized'))).toHaveLength(1)
    expect(t.watcher.devices()).toEqual([])
  })
})
