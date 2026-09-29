import { FakeDriver } from '@coral/runner/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeviceSessions, type SessionDriver } from './device-sessions'

function fakeDevice() {
  const counts = { created: 0, opened: 0, closed: 0, boundTo: [] as string[] }
  const createDriver = (udid: string): Promise<SessionDriver> => {
    counts.created += 1
    const fake = new FakeDriver({ screens: { home: { frames: [[]] } }, start: 'home' })
    return Promise.resolve(
      Object.assign(fake, {
        udid,
        open: () => Promise.resolve(void (counts.opened += 1)),
        close: () => Promise.resolve(void (counts.closed += 1)),
        forApp: (appId: string) => {
          counts.boundTo.push(appId)
          return fake
        },
      }),
    )
  }
  return { counts, createDriver }
}

afterEach(() => vi.useRealTimers())

describe('DeviceSessions (research R6)', () => {
  it('opens one driver per device and shares it', async () => {
    const { counts, createDriver } = fakeDevice()
    const sessions = new DeviceSessions({ createDriver })
    const [job, stream] = await Promise.all([
      sessions.acquire('emulator-5554', { appId: 'com.x.app' }),
      sessions.acquire('emulator-5554'),
    ])
    expect(counts).toMatchObject({ created: 1, opened: 1, boundTo: ['com.x.app'] })
    await sessions.acquire('emulator-5556')
    expect(counts.created).toBe(2)
    await job.release()
    await stream.release()
    await sessions.closeAll()
    expect(counts.closed).toBe(2)
  })

  it('closes a device only after it has been idle', async () => {
    vi.useFakeTimers()
    const { counts, createDriver } = fakeDevice()
    const sessions = new DeviceSessions({ createDriver, idleMs: 60_000 })
    const first = await sessions.acquire('emulator-5554')
    await first.release()
    await first.release() // twice is harmless
    await vi.advanceTimersByTimeAsync(30_000)
    // Back within the idle time: same session, no reopen.
    const second = await sessions.acquire('emulator-5554')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(counts).toMatchObject({ opened: 1, closed: 0 })
    await second.release()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(counts.closed).toBe(1)
    expect(sessions.isOpen('emulator-5554')).toBe(false)
  })

  it('closes at once with idleMs 0 and retries a failed open', async () => {
    const { counts, createDriver } = fakeDevice()
    let fail = true
    const sessions = new DeviceSessions({
      idleMs: 0,
      createDriver: (udid) =>
        fail
          ? ((fail = false), Promise.reject(new Error('adb: device offline')))
          : createDriver(udid),
    })
    await expect(sessions.acquire('emulator-5554')).rejects.toThrow('device offline')
    const lease = await sessions.acquire('emulator-5554')
    await lease.release()
    expect(counts).toMatchObject({ opened: 1, closed: 1 })
  })

  it('logs a failing cleanup instead of throwing', async () => {
    const warn = vi.fn()
    const sessions = new DeviceSessions({
      idleMs: 0,
      log: { warn, error: vi.fn() },
      createDriver: () =>
        Promise.resolve(
          Object.assign(new FakeDriver({ screens: { a: { frames: [[]] } }, start: 'a' }), {
            open: () => Promise.resolve(),
            close: () => Promise.reject(new Error('u2 already gone')),
          }),
        ),
    })
    await (await sessions.acquire('emulator-5554')).release()
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ udid: 'emulator-5554' }),
      'driver cleanup failed',
    )
  })
})
