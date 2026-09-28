import { and, desc, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { builds } from '../db/schema'
import { notFound } from '../http/errors'

export type BuildRow = typeof builds.$inferSelect

export function buildsRepo(db: Db, tenantId: string) {
  return {
    list(appId: string) {
      return db
        .select()
        .from(builds)
        .where(and(eq(builds.tenantId, tenantId), eq(builds.appId, appId)))
        .orderBy(desc(builds.createdAt))
    },

    async get(id: string): Promise<BuildRow> {
      const [row] = await db
        .select()
        .from(builds)
        .where(and(eq(builds.tenantId, tenantId), eq(builds.id, id)))
      if (!row) throw notFound('build')
      return row
    },

    async create(input: Omit<typeof builds.$inferInsert, 'tenantId' | 'createdAt'>) {
      const [row] = await db
        .insert(builds)
        .values({ ...input, tenantId })
        .returning()
      if (!row) throw new Error('build not stored')
      return row
    },
  }
}
