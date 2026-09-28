import type { Db } from '../db/client'
import type { ProjectRepoStore } from '../git/project-repo-store'
import { audit, type AuditEntry } from './audit'
import { identityRepo } from './identity'
import { projectsRepo } from './projects'

export interface RepoDeps {
  db: Db
  store: ProjectRepoStore
}

/**
 * Entry point of the data layer for routes (constitution V: routes never touch db/**).
 * Everything business-related goes through `tenant(id)`, so every query is tenant-scoped (P5).
 */
export function createRepos({ db, store }: RepoDeps) {
  return {
    identity: identityRepo(db),
    tenant(tenantId: string) {
      return {
        tenantId,
        projects: projectsRepo(db, tenantId, store),
        audit: (entry: Omit<AuditEntry, 'tenantId'>) => audit(db, { tenantId, ...entry }),
      }
    },
  }
}

export type Repos = ReturnType<typeof createRepos>
export type TenantRepos = ReturnType<Repos['tenant']>
