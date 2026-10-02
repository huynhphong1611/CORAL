import type { GitAuthor, ProjectRepoStore } from '../git/project-repo-store'
import { conflict, notFound } from '../http/errors'
import type { ProjectsRepo } from './projects'

/** A file of the project's knowledge and the commit the editor bases its next save on. */
export interface KnowledgeFile {
  content: string | null
  /** The last commit that changed it, or the repo's head while it does not exist. */
  headCommit: string
}

/**
 * The project's knowledge in its git repo (contracts/project-knowledge.md, §13): `AGENTS.md`,
 * `skills/<name>/`, `mcp.yaml`. Every save is one commit; a save based on another version of the
 * same file or folder than the one now there is refused (409 `conflict`, like the editor).
 */
export function knowledgeRepo(tenantId: string, store: ProjectRepoStore, projects: ProjectsRepo) {
  /** The last commit that touched `path` (a file or a folder); undefined when none did. */
  async function lastCommit(projectId: string, path: string): Promise<string | undefined> {
    return (await store.history(tenantId, projectId, path))[0]?.commit
  }

  return {
    async read(projectId: string, path: string): Promise<KnowledgeFile> {
      await projects.get(projectId)
      const content = await store.readFile(tenantId, projectId, path)
      const headCommit =
        (await lastCommit(projectId, path)) ?? (await store.head(tenantId, projectId))
      return { content, headCommit }
    },

    /** The commit an editor of `path` (a file or a folder) bases its next save on. */
    async head(projectId: string, path: string): Promise<string> {
      await projects.get(projectId)
      return (await lastCommit(projectId, path)) ?? (await store.head(tenantId, projectId))
    },

    /** Files under `dir` at head (e.g. every `skills/<name>/SKILL.md`). */
    async list(projectId: string, dir: string): Promise<string[]> {
      await projects.get(projectId)
      return store.listFiles(tenantId, projectId, dir)
    },

    /**
     * Writes `files` and removes `removePaths` in one commit, unless `scope` (the file or folder
     * being edited) changed since `baseCommit`. Returns the new head of `scope`.
     */
    async write(
      projectId: string,
      input: {
        scope: string
        baseCommit: string
        files: Record<string, string>
        removePaths?: string[]
        author: GitAuthor
        message: string
      },
    ): Promise<string> {
      await projects.get(projectId)
      await store.updateFiles(tenantId, projectId, async () => {
        const last = await lastCommit(projectId, input.scope)
        // Never written: any base is fine; written since the editor read it: refused.
        if (last !== undefined && last !== input.baseCommit) {
          throw conflict('conflict', `${input.scope} changed since base_commit`)
        }
        return {
          files: input.files,
          ...(input.removePaths ? { removeDirs: input.removePaths } : {}),
          author: input.author,
          message: input.message,
        }
      })
      // Unchanged content makes no commit: the scope keeps its last one.
      return (await lastCommit(projectId, input.scope)) ?? (await store.head(tenantId, projectId))
    },

    /** Removes a folder in one commit (a skill); 404 when it is not there. */
    async remove(
      projectId: string,
      input: { scope: string; baseCommit: string; author: GitAuthor; message: string },
    ): Promise<string> {
      await projects.get(projectId)
      if ((await store.listFiles(tenantId, projectId, input.scope)).length === 0) {
        throw notFound(input.scope)
      }
      return this.write(projectId, { ...input, files: {}, removePaths: [input.scope] })
    },
  }
}

export type KnowledgeRepo = ReturnType<typeof knowledgeRepo>
