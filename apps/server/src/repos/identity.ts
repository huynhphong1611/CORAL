import { and, eq, gt, isNull } from 'drizzle-orm'
import type { Db } from '../db/client'
import type { ROLES } from '../db/schema'
import { memberships, refreshTokens, tenants, users } from '../db/schema'

/**
 * Global identity tables (D10): only the auth module uses this repository.
 * Phase 1 has one tenant per user; the first membership is the session tenant.
 */
export function identityRepo(db: Db) {
  return {
    async findUserWithTenant(email: string) {
      const rows = await db
        .select({ user: users, membership: memberships, tenant: tenants })
        .from(users)
        .innerJoin(memberships, eq(memberships.userId, users.id))
        .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
        .where(eq(users.email, email.toLowerCase()))
        .orderBy(memberships.createdAt)
        .limit(1)
      return rows[0]
    },

    /** The session identity of a user: their first membership (Phase 1 has one per user). */
    async findUserWithTenantByUserId(userId: string) {
      const rows = await db
        .select({ user: users, membership: memberships, tenant: tenants })
        .from(users)
        .innerJoin(memberships, eq(memberships.userId, users.id))
        .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
        .where(eq(users.id, userId))
        .orderBy(memberships.createdAt)
        .limit(1)
      return rows[0]
    },

    async findUserWithTenantById(userId: string, tenantId: string) {
      const rows = await db
        .select({ user: users, membership: memberships, tenant: tenants })
        .from(users)
        .innerJoin(memberships, eq(memberships.userId, users.id))
        .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
        .where(and(eq(users.id, userId), eq(tenants.id, tenantId)))
        .limit(1)
      return rows[0]
    },

    async createRefreshToken(userId: string, tokenHash: string, expiresAt: Date) {
      const [row] = await db
        .insert(refreshTokens)
        .values({ userId, tokenHash, expiresAt })
        .returning()
      if (!row) throw new Error('refresh token not stored')
      return row
    },

    /** Atomically revokes a live refresh token; returns it, or undefined if unknown/expired/revoked. */
    async consumeRefreshToken(tokenHash: string, now: Date) {
      const [row] = await db
        .update(refreshTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(refreshTokens.tokenHash, tokenHash),
            isNull(refreshTokens.revokedAt),
            gt(refreshTokens.expiresAt, now),
          ),
        )
        .returning()
      return row
    },

    async linkReplacement(oldId: string, newId: string) {
      await db.update(refreshTokens).set({ replacedBy: newId }).where(eq(refreshTokens.id, oldId))
    },

    async revokeRefreshToken(tokenHash: string, now: Date) {
      await db
        .update(refreshTokens)
        .set({ revokedAt: now })
        .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)))
    },

    /** Idempotent seed: one tenant + one owner (Phase 1). */
    async seedOwner(input: {
      email: string
      passwordHash: string
      name: string
      tenantName: string
    }) {
      return db.transaction(async (tx) => {
        const email = input.email.toLowerCase()
        const [existing] = await tx.select().from(users).where(eq(users.email, email)).limit(1)
        if (existing) return { userId: existing.id, created: false }
        const [tenant] = await tx.insert(tenants).values({ name: input.tenantName }).returning()
        const [user] = await tx
          .insert(users)
          .values({ email, passwordHash: input.passwordHash, name: input.name })
          .returning()
        if (!tenant || !user) throw new Error('seed failed')
        await tx.insert(memberships).values({ tenantId: tenant.id, userId: user.id, role: 'owner' })
        return { userId: user.id, tenantId: tenant.id, created: true }
      })
    },

    /** A new user in an existing tenant (seed and tests; inviting people is a later phase). */
    async addMember(input: {
      tenantId: string
      email: string
      passwordHash: string
      name: string
      role: (typeof ROLES)[number]
    }) {
      return db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({
            email: input.email.toLowerCase(),
            passwordHash: input.passwordHash,
            name: input.name,
          })
          .returning()
        if (!user) throw new Error('user not created')
        await tx
          .insert(memberships)
          .values({ tenantId: input.tenantId, userId: user.id, role: input.role })
        return { userId: user.id }
      })
    },
  }
}

export type IdentityRepo = ReturnType<typeof identityRepo>
