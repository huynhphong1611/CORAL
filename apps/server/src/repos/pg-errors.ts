/** Postgres unique_violation (23505), also when Drizzle wraps the driver error in `cause`. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    const pg = e as Error & { code?: string; constraint?: string }
    if (pg.code === '23505') return constraint === undefined || pg.constraint === constraint
  }
  return false
}
