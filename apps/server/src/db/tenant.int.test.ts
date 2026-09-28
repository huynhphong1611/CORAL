import { sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../config'
import { createDatabase } from './client'
import { withTenant } from './tenant'

const database = createDatabase(loadConfig(process.env).databaseUrl)
afterAll(() => database.close())

async function currentTenant(run: (q: typeof sql) => Promise<{ rows: unknown[] }>) {
  const { rows } = await run(sql)
  return (rows[0] as { tenant: string | null }).tenant
}

describe('withTenant', () => {
  it('sets app.tenant_id inside the transaction only', async () => {
    const tenantId = '0192f000-0000-7000-8000-000000000001'
    const inside = await withTenant(database.db, tenantId, (tx) =>
      currentTenant((q) => tx.execute(q`select current_setting('app.tenant_id', true) as tenant`)),
    )
    expect(inside).toBe(tenantId)

    const after = await currentTenant((q) =>
      database.db.execute(q`select nullif(current_setting('app.tenant_id', true), '') as tenant`),
    )
    expect(after).toBeNull()
  })

  it('rolls back when the callback throws', async () => {
    await expect(
      withTenant(database.db, '0192f000-0000-7000-8000-000000000002', () =>
        Promise.reject(new Error('boom')),
      ),
    ).rejects.toThrow('boom')
  })
})
