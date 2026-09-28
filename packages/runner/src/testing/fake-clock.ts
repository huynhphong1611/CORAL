import { AbortError, type Clock } from '../core/clock'

/** Clock whose sleep() returns at once and advances virtual time (unit tests). */
export class FakeClock implements Clock {
  readonly sleeps: number[] = []

  constructor(public time = 0) {}

  now(): number {
    return this.time
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new AbortError())
    this.sleeps.push(ms)
    this.time += ms
    return Promise.resolve()
  }
}
