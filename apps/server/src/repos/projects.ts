import { DEFAULT_POPUPS_YAML, newId } from '@coral/shared'
import { rm } from 'node:fs/promises'
import { and, asc, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { apps, projectFiles, projects } from '../db/schema'
import type { GitAuthor, ProjectRepoStore } from '../git/project-repo-store'
import { conflict, notFound } from '../http/errors'
import { isUniqueViolation } from './pg-errors'

export const POPUPS_PATH = 'popups.yaml'

function readme(name: string): string {
  return `# ${name}\n\nTest cases of this project, managed by coral (SPEC §13.1).\n\n- \`testcases/<slug>.yaml\` — coral/testcase@1\n- \`popups.yaml\` — coral/popups@1\n`
}

/** Projects, their apps and tracked project files, scoped to one tenant (P5). */
export function projectsRepo(db: Db, tenantId: string, store: ProjectRepoStore) {
  const inTenant = eq(projects.tenantId, tenantId)

  return {
    list() {
      return db.select().from(projects).where(inTenant).orderBy(asc(projects.name))
    },

    async get(id: string) {
      const [row] = await db
        .select()
        .from(projects)
        .where(and(inTenant, eq(projects.id, id)))
      if (!row) throw notFound('project')
      return row
    },

    /** Creates the row and its git repository (default popups.yaml + README.md) together. */
    async create(name: string, author: GitAuthor) {
      const id = newId()
      const gitRepoPath = store.repoPath(tenantId, id)
      try {
        return await db.transaction(async (tx) => {
          const [project] = await tx
            .insert(projects)
            .values({ id, tenantId, name, gitRepoPath })
            .returning()
          if (!project) throw new Error('project not stored')
          const commit = await store.init(tenantId, id, {
            files: { [POPUPS_PATH]: DEFAULT_POPUPS_YAML, 'README.md': readme(name) },
            author,
            message: 'project: init',
          })
          await tx.insert(projectFiles).values({
            tenantId,
            projectId: id,
            kind: 'popups',
            pathInRepo: POPUPS_PATH,
            headCommit: commit,
          })
          return project
        })
      } catch (error) {
        await rm(gitRepoPath, { recursive: true, force: true })
        if (isUniqueViolation(error)) throw conflict('duplicate_name', `project "${name}" exists`)
        throw error
      }
    },

    async listApps(projectId: string) {
      await this.get(projectId)
      return db
        .select()
        .from(apps)
        .where(and(eq(apps.tenantId, tenantId), eq(apps.projectId, projectId)))
        .orderBy(asc(apps.createdAt))
    },

    async createApp(
      projectId: string,
      input: { platform: 'android'; packageOrBundleId: string; name: string },
    ) {
      await this.get(projectId)
      try {
        const [app] = await db
          .insert(apps)
          .values({ tenantId, projectId, ...input })
          .returning()
        if (!app) throw new Error('app not stored')
        return app
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict('duplicate_app', `${input.packageOrBundleId} is already in this project`)
        }
        throw error
      }
    },

    async getApp(appId: string) {
      const [app] = await db
        .select()
        .from(apps)
        .where(and(eq(apps.tenantId, tenantId), eq(apps.id, appId)))
      if (!app) throw notFound('app')
      return app
    },

    async projectFile(projectId: string, kind: 'popups') {
      const [file] = await db
        .select()
        .from(projectFiles)
        .where(
          and(
            eq(projectFiles.tenantId, tenantId),
            eq(projectFiles.projectId, projectId),
            eq(projectFiles.kind, kind),
          ),
        )
      if (!file) throw notFound('project file')
      return file
    },
  }
}

export type ProjectsRepo = ReturnType<typeof projectsRepo>
