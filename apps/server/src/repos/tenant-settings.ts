import type { BrainsConfig } from '@coral/shared'
import { eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { tenants } from '../db/schema'

/** `tenants.settings.brains`: the YAML as written (comments kept) and the checked config (D20). */
export interface StoredBrains {
  yaml: string
  config: BrainsConfig
  updated_at: string
  updated_by: string
}

interface TenantSettings {
  brains?: StoredBrains
}

/** The tenant's own settings (`tenants.settings`), one key at a time. */
export function tenantSettingsRepo(db: Db, tenantId: string) {
  return {
    async brains(): Promise<StoredBrains | undefined> {
      const [row] = await db
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
      return (row?.settings as TenantSettings | undefined)?.brains
    },

    async setBrains(value: StoredBrains): Promise<void> {
      await db
        .update(tenants)
        .set({
          settings: sql`jsonb_set(${tenants.settings}, '{brains}', ${JSON.stringify(value)}::jsonb)`,
        })
        .where(eq(tenants.id, tenantId))
    },
  }
}

export type TenantSettingsRepo = ReturnType<typeof tenantSettingsRepo>
