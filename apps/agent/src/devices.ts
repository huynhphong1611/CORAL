import type { protocol } from '@coral/shared'
import type { Logger } from 'pino'

type DeviceInfo = protocol.DeviceInfo

export const DEVICE_POLL_MS = 5000

/** What the watcher needs from adb (runner's Adb in production, a fake in tests). */
export interface DeviceSource {
  list(): Promise<{ udid: string; state: string }[]>
  props(
    udid: string,
  ): Promise<{ model: string; osVersion: string; apiLevel: number; emulator: boolean }>
}

export interface DeviceUpdate {
  added: DeviceInfo[]
  removed: string[]
  changed: DeviceInfo[]
}

/**
 * Follows `adb devices` (T052): every poll produces a device.update with what was added, removed
 * or changed. Unauthorized devices are never reported — only a warning, once per device.
 */
export class DeviceWatcher {
  private known = new Map<string, DeviceInfo>()
  private readonly props = new Map<string, Omit<DeviceInfo, 'status'>>()
  private readonly warned = new Set<string>()
  private timer: NodeJS.Timeout | undefined
  private polling: Promise<void> | undefined

  constructor(
    private readonly options: {
      source: DeviceSource
      /** Is a job running on this device right now? */
      busy: (udid: string) => boolean
      onUpdate: (update: DeviceUpdate) => void
      intervalMs?: number
      log?: Pick<Logger, 'warn' | 'info'>
    },
  ) {}

  /** Current devices (agent.hello, heartbeat). */
  devices(): DeviceInfo[] {
    return [...this.known.values()].map((d) => ({ ...d, status: this.status(d.udid) }))
  }

  statuses(): { udid: string; status: DeviceInfo['status'] }[] {
    return this.devices().map((d) => ({ udid: d.udid, status: d.status }))
  }

  start(): void {
    this.timer = setInterval(() => void this.poll(), this.options.intervalMs ?? DEVICE_POLL_MS)
    this.timer.unref()
  }

  stop(): void {
    clearInterval(this.timer)
  }

  private status(udid: string): DeviceInfo['status'] {
    return this.options.busy(udid) ? 'busy' : 'idle'
  }

  /** Reads adb once; reports the difference (nothing when nothing changed). */
  poll(): Promise<void> {
    this.polling ??= this.read().finally(() => (this.polling = undefined))
    return this.polling
  }

  private async read(): Promise<void> {
    let listed: { udid: string; state: string }[]
    try {
      listed = await this.options.source.list()
    } catch (error) {
      this.options.log?.warn({ err: error }, 'adb devices failed')
      return
    }
    const next = new Map<string, DeviceInfo>()
    for (const { udid, state } of listed) {
      if (state === 'unauthorized') {
        if (!this.warned.has(udid)) {
          this.warned.add(udid)
          this.options.log?.warn(
            { udid },
            'device is unauthorized: accept the USB debugging prompt on the phone',
          )
        }
        continue
      }
      if (state !== 'device') continue
      let base = this.props.get(udid)
      if (!base) {
        try {
          const p = await this.options.source.props(udid)
          base = {
            udid,
            platform: 'android',
            kind: p.emulator ? 'emulator' : 'real',
            model: p.model,
            os_version: p.osVersion,
            api_level: p.apiLevel,
          }
          this.props.set(udid, base)
        } catch (error) {
          this.options.log?.warn({ err: error, udid }, 'cannot read device properties')
          continue
        }
      }
      next.set(udid, { ...base, status: this.status(udid) })
    }

    const added = [...next.values()].filter((d) => !this.known.has(d.udid))
    const removed = [...this.known.keys()].filter((udid) => !next.has(udid))
    const changed = [...next.values()].filter((d) => {
      const before = this.known.get(d.udid)
      return before !== undefined && JSON.stringify(before) !== JSON.stringify(d)
    })
    for (const udid of removed) this.props.delete(udid)
    this.known = next
    if (added.length || removed.length || changed.length) {
      this.options.onUpdate({ added, removed, changed })
    }
  }
}
