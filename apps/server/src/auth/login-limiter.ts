/** In-memory limit of failed logins per email (single server instance, R10). */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>()

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  private recent(email: string, now: number): number[] {
    const list = (this.failures.get(email) ?? []).filter((t) => now - t < this.windowMs)
    this.failures.set(email, list)
    return list
  }

  isBlocked(email: string, now = Date.now()): boolean {
    return this.recent(email, now).length >= this.maxFailures
  }

  recordFailure(email: string, now = Date.now()): void {
    this.recent(email, now).push(now)
  }

  reset(email: string): void {
    this.failures.delete(email)
  }
}
