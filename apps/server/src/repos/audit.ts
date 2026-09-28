import type { Db, Tx } from '../db/client'
import { auditLog } from '../db/schema'

export interface AuditEntry {
  tenantId: string
  actor: string
  action: string
  target?: string
  meta?: Record<string, unknown>
}

/** Appends to audit_log (SPEC §17). Never pass secrets in `meta`. */
export async function audit(db: Db | Tx, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    tenantId: entry.tenantId,
    actor: entry.actor,
    action: entry.action,
    target: entry.target ?? null,
    meta: entry.meta ?? {},
  })
}
