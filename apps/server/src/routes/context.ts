import type { FastifyRequest } from 'fastify'
import { authOf, type AuthContext } from '../auth/guard'
import type { GitAuthor } from '../git/project-repo-store'
import { HttpError } from '../http/errors'
import type { Repos, TenantRepos } from '../repos'

/** Repositories of the caller's tenant plus who the caller is. */
export function scope(repos: Repos, request: FastifyRequest): TenantRepos & { auth: AuthContext } {
  const auth = authOf(request)
  return { ...repos.tenant(auth.tenantId), auth }
}

/** Git author of a change made through the API (D15: every edit is a commit by its author). */
export async function gitAuthor(repos: Repos, auth: AuthContext): Promise<GitAuthor> {
  const identity = await repos.identity.findUserWithTenantById(auth.userId, auth.tenantId)
  if (!identity) throw new HttpError(401, 'unauthorized', 'user no longer exists')
  return { name: identity.user.name, email: identity.user.email }
}

export const iso = (date: Date) => date.toISOString()
export const isoOrNull = (date: Date | null) => (date ? date.toISOString() : null)
