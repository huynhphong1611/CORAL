import { sql } from 'drizzle-orm'
import type { Db, Tx } from './client'

/**
 * Runs `fn` in a transaction scoped to one tenant: `app.tenant_id` is set for the transaction
 * only (set_config(…, true)), ready for Postgres RLS policies in Phase 5 (SPEC §17).
 */
export async function withTenant<T>(
  db: Db,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`)
    return fn(tx)
  })
}
