import type { Db } from '../db/client'
import type { ProjectRepoStore } from '../git/project-repo-store'
import { agentsRepo } from './agents'
import { audit, type AuditEntry } from './audit'
import { brainCallsRepo } from './brain-calls'
import { buildsRepo } from './builds'
import { explorationsRepo } from './explorations'
import { identityRepo } from './identity'
import { importsRepo } from './imports'
import { projectsRepo } from './projects'
import { runsRepo } from './runs'
import { tenantSettingsRepo } from './tenant-settings'
import { testCasesRepo } from './test-cases'

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
      const projects = projectsRepo(db, tenantId, store)
      return {
        tenantId,
        projects,
        builds: buildsRepo(db, tenantId),
        agents: agentsRepo(db, tenantId),
        testCases: testCasesRepo(db, tenantId, store, projects),
        runs: runsRepo(db, tenantId),
        explorations: explorationsRepo(db, tenantId),
        brainCalls: brainCallsRepo(db, tenantId),
        imports: importsRepo(db, tenantId),
        settings: tenantSettingsRepo(db, tenantId),
        audit: (entry: Omit<AuditEntry, 'tenantId'>) => audit(db, { tenantId, ...entry }),
      }
    },
  }
}

export type Repos = ReturnType<typeof createRepos>
export type TenantRepos = ReturnType<Repos['tenant']>
