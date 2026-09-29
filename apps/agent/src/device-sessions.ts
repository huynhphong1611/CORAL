import type { DeviceDriver, FrameSource } from '@coral/runner'
import type { Logger } from 'pino'

/** A device driver the agent opens once per device and shares (research R6). */
export interface SessionDriver extends DeviceDriver, Partial<FrameSource> {
  open(): Promise<void>
  /** Minimal cleanup (T053): restore animations on real devices, stop u2. No uninstall, no wipe. */
  close(): Promise<void>
  /** The same device and u2 server with the lifecycle bound to an app (jobs, restart_app). */
  forApp?(appId: string): DeviceDriver
}

export interface DeviceLease {
  /** Bound to the app when acquired with one; can stream frames when the platform can. */
  driver: DeviceDriver & Partial<FrameSource>
  /** Gives the device back; the session closes once nobody uses it for `idleMs`. */
  release(): Promise<void>
}

export interface DeviceSessionsOptions {
  createDriver(udid: string): Promise<SessionDriver>
  /** How long an unused session stays open (default 60 s; 0 closes at once). */
  idleMs?: number
  log?: Pick<Logger, 'warn' | 'error'>
}

interface Session {
  ready: Promise<SessionDriver>
  users: number
  idle: NodeJS.Timeout | undefined
}

/**
 * One open driver — one u2 server — per device, shared by a job, the live-view streamer and
 * remote commands: a second u2 on the same device takes UiAutomation away from the first (seen
 * on the CI emulator in Phase 1). Opened lazily, closed after `idleMs` without users, all closed
 * when the agent stops.
 */
export class DeviceSessions {
  private readonly sessions = new Map<string, Session>()

  constructor(private readonly options: DeviceSessionsOptions) {}

  /** Opens (or reuses) the device's session; with `appId`, the driver is bound to that app. */
  async acquire(udid: string, input: { appId?: string } = {}): Promise<DeviceLease> {
    let session = this.sessions.get(udid)
    if (!session) {
      const created: Session = { ready: this.open(udid), users: 0, idle: undefined }
      this.sessions.set(udid, created)
      session = created
    }
    session.users += 1
    if (session.idle) clearTimeout(session.idle)
    session.idle = undefined
    let base: SessionDriver
    try {
      base = await session.ready
    } catch (error) {
      session.users -= 1
      // A failed open is forgotten so the next acquire tries again.
      if (this.sessions.get(udid) === session) this.sessions.delete(udid)
      throw error
    }
    const driver = input.appId && base.forApp ? base.forApp(input.appId) : base
    let released = false
    return {
      driver,
      release: async () => {
        if (released) return
        released = true
        await this.release(udid, session)
      },
    }
  }

  /** Whether the device has an open (or opening) session. */
  isOpen(udid: string): boolean {
    return this.sessions.has(udid)
  }

  /** Closes a device's session now, e.g. when the device disappeared. */
  async closeDevice(udid: string): Promise<void> {
    const session = this.sessions.get(udid)
    if (!session) return
    this.sessions.delete(udid)
    if (session.idle) clearTimeout(session.idle)
    await this.close(udid, session)
  }

  /** Closes every session (agent shutdown). */
  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((udid) => this.closeDevice(udid)))
  }

  private async open(udid: string): Promise<SessionDriver> {
    const driver = await this.options.createDriver(udid)
    await driver.open()
    return driver
  }

  private async release(udid: string, session: Session): Promise<void> {
    session.users -= 1
    if (session.users > 0 || this.sessions.get(udid) !== session) return
    const idleMs = this.options.idleMs ?? 60_000
    if (idleMs <= 0) {
      this.sessions.delete(udid)
      await this.close(udid, session)
      return
    }
    session.idle = setTimeout(() => {
      if (this.sessions.get(udid) !== session || session.users > 0) return
      this.sessions.delete(udid)
      void this.close(udid, session)
    }, idleMs)
    session.idle.unref()
  }

  private async close(udid: string, session: Session): Promise<void> {
    try {
      const driver = await session.ready
      await driver.close()
    } catch (error) {
      this.options.log?.warn({ err: error, udid }, 'driver cleanup failed')
    }
  }
}
