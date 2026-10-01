import { newId, type api } from '@coral/shared'
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { brainCalls, toolCalls } from '../db/schema'
import { notFound } from '../http/errors'

export type BrainCallRow = typeof brainCalls.$inferSelect
export type NewBrainCall = Omit<typeof brainCalls.$inferInsert, 'tenantId'>
export type ToolCallRow = typeof toolCalls.$inferSelect
export type NewToolCall = Omit<typeof toolCalls.$inferInsert, 'tenantId'>

const DAY_MS = 24 * 60 * 60 * 1000

/** Start of the UTC day that contains `at` (limits and usage count UTC days, FR-010). */
export function utcDayStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
}

/** `YYYY-MM-DD` (UTC) → the instant that day starts. */
const dayStart = (date: string) => new Date(`${date}T00:00:00.000Z`)

/**
 * Every attempt to call an AI provider (one row per attempt, D41) and the tool calls made
 * inside it. Costs are summed here for the daily limit and the budget of an exploration or
 * import job. Tenant-scoped (P5).
 */
export function brainCallsRepo(db: Db, tenantId: string) {
  const inTenant = eq(brainCalls.tenantId, tenantId)
  const total = sql<number>`coalesce(sum(${brainCalls.costUsd}), 0)::float8`

  return {
    async record(call: NewBrainCall): Promise<BrainCallRow> {
      const [row] = await db
        .insert(brainCalls)
        .values({ id: newId(), ...call, tenantId })
        .returning()
      if (!row) throw new Error('brain call not stored')
      return row
    },

    async setContentKey(id: string, contentKey: string): Promise<void> {
      await db
        .update(brainCalls)
        .set({ contentKey })
        .where(and(inTenant, eq(brainCalls.id, id)))
    },

    async get(id: string): Promise<BrainCallRow> {
      const [row] = await db
        .select()
        .from(brainCalls)
        .where(and(inTenant, eq(brainCalls.id, id)))
      if (!row) throw notFound('brain call')
      return row
    },

    /** What the tenant spent on AI during the UTC day that contains `at`. */
    async costOfDay(at = new Date()): Promise<number> {
      const start = utcDayStart(at)
      const [row] = await db
        .select({ total })
        .from(brainCalls)
        .where(
          and(
            inTenant,
            gte(brainCalls.createdAt, start),
            lt(brainCalls.createdAt, new Date(start.getTime() + DAY_MS)),
          ),
        )
      return row?.total ?? 0
    },

    /** What one exploration or import job spent so far. */
    async costOf(refType: api.BrainCallRefType, refId: string): Promise<number> {
      const [row] = await db
        .select({ total })
        .from(brainCalls)
        .where(and(inTenant, eq(brainCalls.refType, refType), eq(brainCalls.refId, refId)))
      return row?.total ?? 0
    },

    /** `GET /usage/ai`: totals per UTC day, role or provider between two UTC dates (inclusive). */
    async usage(query: { from?: string; to?: string; group: 'day' | 'role' | 'provider' }) {
      const key =
        query.group === 'day'
          ? sql<string>`to_char(${brainCalls.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`
          : query.group === 'role'
            ? sql<string>`${brainCalls.role}`
            : sql<string>`${brainCalls.provider}`
      const rows = await db
        .select({
          key,
          calls: sql<number>`count(*)::int`,
          tokens_in: sql<number>`coalesce(sum(${brainCalls.tokensIn}), 0)::int`,
          tokens_out: sql<number>`coalesce(sum(${brainCalls.tokensOut}), 0)::int`,
          cost_usd: total,
        })
        .from(brainCalls)
        .where(
          and(
            inTenant,
            query.from ? gte(brainCalls.createdAt, dayStart(query.from)) : undefined,
            query.to
              ? lt(brainCalls.createdAt, new Date(dayStart(query.to).getTime() + DAY_MS))
              : undefined,
          ),
        )
        .groupBy(key)
        .orderBy(key)
      return rows
    },

    async recordTool(call: NewToolCall): Promise<ToolCallRow> {
      const [row] = await db
        .insert(toolCalls)
        .values({ id: newId(), ...call, tenantId })
        .returning()
      if (!row) throw new Error('tool call not stored')
      return row
    },

    /** Tool calls of some brain calls, in the order they were made. */
    toolCalls(brainCallIds: readonly string[]): Promise<ToolCallRow[]> {
      if (brainCallIds.length === 0) return Promise.resolve([])
      return db
        .select()
        .from(toolCalls)
        .where(
          and(eq(toolCalls.tenantId, tenantId), inArray(toolCalls.brainCallId, [...brainCallIds])),
        )
        .orderBy(asc(toolCalls.createdAt))
    },
  }
}

export type BrainCallsRepo = ReturnType<typeof brainCallsRepo>
