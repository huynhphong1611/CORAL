import type { TestCase } from '@coral/shared'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Db } from '../db/client'
import { projectFiles, testCases } from '../db/schema'
import type { GitAuthor, ProjectRepoStore } from '../git/project-repo-store'
import { conflict, HttpError, notFound } from '../http/errors'
import { isUniqueViolation } from './pg-errors'
import { POPUPS_PATH, type ProjectsRepo } from './projects'

export type TestCaseRow = typeof testCases.$inferSelect

/** Placeholder head while the first commit is being written inside the transaction. */
const PENDING_COMMIT = '0'.repeat(40)

export const testCasePath = (slug: string) => `testcases/${slug}.yaml`

/**
 * Test cases live in the project's git repo; this table is the index (D15, D31). Every change is
 * validated by the caller, then committed here with the DB row updated in the same transaction.
 */
export function testCasesRepo(
  db: Db,
  tenantId: string,
  store: ProjectRepoStore,
  projects: ProjectsRepo,
) {
  const inTenant = eq(testCases.tenantId, tenantId)

  return {
    async list(projectId: string) {
      await projects.get(projectId)
      return db
        .select()
        .from(testCases)
        .where(and(inTenant, eq(testCases.projectId, projectId)))
        .orderBy(asc(testCases.slug))
    },

    async get(id: string): Promise<TestCaseRow> {
      const [row] = await db
        .select()
        .from(testCases)
        .where(and(inTenant, eq(testCases.id, id)))
      if (!row) throw notFound('test case')
      return row
    },

    async getMany(ids: readonly string[]): Promise<TestCaseRow[]> {
      if (ids.length === 0) return []
      return db
        .select()
        .from(testCases)
        .where(and(inTenant, inArray(testCases.id, [...ids])))
    },

    /** YAML at `commit` (default: head); 404 when the file does not exist at that commit. */
    async readYaml(row: TestCaseRow, commit?: string): Promise<string> {
      const yaml = await store.readFile(
        tenantId,
        row.projectId,
        row.pathInRepo,
        commit ?? row.headCommit,
      )
      if (yaml === null) throw notFound('test case version')
      return yaml
    },

    history(row: TestCaseRow) {
      return store.history(tenantId, row.projectId, row.pathInRepo)
    },

    async create(
      projectId: string,
      input: { testCase: TestCase; yaml: string; author: GitAuthor; userId: string },
    ): Promise<TestCaseRow> {
      await projects.get(projectId)
      const { testCase } = input
      const pathInRepo = testCasePath(testCase.id)
      try {
        return await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(testCases)
            .values({
              tenantId,
              projectId,
              slug: testCase.id,
              pathInRepo,
              intent: testCase.intent,
              tags: testCase.tags ?? [],
              platforms: [...testCase.platforms],
              headCommit: PENDING_COMMIT,
              source: 'manual',
              updatedBy: input.userId,
            })
            .returning()
          if (!row) throw new Error('test case not stored')
          const commit = await store.writeFile(tenantId, projectId, {
            path: pathInRepo,
            content: input.yaml,
            author: input.author,
            message: `testcase: ${testCase.id}`,
          })
          const [saved] = await tx
            .update(testCases)
            .set({ headCommit: commit })
            .where(eq(testCases.id, row.id))
            .returning()
          if (!saved) throw new Error('test case not stored')
          return saved
        })
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict('duplicate_slug', `test case "${testCase.id}" already exists`)
        }
        throw error
      }
    },

    /** Optimistic update: 409 when `baseCommit` is not the head any more (no silent overwrite). */
    async update(
      id: string,
      input: {
        testCase: TestCase
        yaml: string
        baseCommit: string
        author: GitAuthor
        userId: string
      },
    ): Promise<TestCaseRow> {
      const row = await this.get(id)
      if (input.testCase.id !== row.slug) {
        throw new HttpError(
          400,
          'validation_failed',
          `id "${input.testCase.id}" must stay "${row.slug}" (renaming is not supported)`,
        )
      }
      return db.transaction(async (tx) => {
        // Locks the row: a concurrent update with the same base waits, then sees a new head.
        const [locked] = await tx
          .update(testCases)
          .set({ updatedAt: new Date() })
          .where(and(eq(testCases.id, id), eq(testCases.headCommit, input.baseCommit)))
          .returning()
        if (!locked) throw conflict('stale_base_commit', 'test case changed since base_commit')
        const commit = await store.writeFile(tenantId, row.projectId, {
          path: row.pathInRepo,
          content: input.yaml,
          author: input.author,
          message: `testcase: ${row.slug}`,
        })
        const [saved] = await tx
          .update(testCases)
          .set({
            headCommit: commit,
            intent: input.testCase.intent,
            tags: input.testCase.tags ?? [],
            platforms: [...input.testCase.platforms],
            updatedBy: input.userId,
            updatedAt: new Date(),
          })
          .where(eq(testCases.id, id))
          .returning()
        if (!saved) throw new Error('test case not stored')
        return saved
      })
    },

    // --- popups.yaml (project file) ---------------------------------------------------------

    async readPopups(projectId: string, commit?: string) {
      const file = await projects.projectFile(projectId, 'popups')
      const at = commit ?? file.headCommit
      const yaml = await store.readFile(tenantId, projectId, POPUPS_PATH, at)
      if (yaml === null) throw notFound('popups.yaml version')
      return { yaml, headCommit: file.headCommit, commit: at }
    },

    async updatePopups(
      projectId: string,
      input: { yaml: string; baseCommit: string; author: GitAuthor },
    ): Promise<string> {
      await projects.projectFile(projectId, 'popups')
      return db.transaction(async (tx) => {
        const current = and(
          eq(projectFiles.tenantId, tenantId),
          eq(projectFiles.projectId, projectId),
          eq(projectFiles.kind, 'popups'),
        )
        // Row lock + base check in one statement, like test cases.
        const [locked] = await tx
          .update(projectFiles)
          .set({ updatedAt: new Date() })
          .where(and(current, eq(projectFiles.headCommit, input.baseCommit)))
          .returning()
        if (!locked) throw conflict('stale_base_commit', 'popups.yaml changed since base_commit')
        const commit = await store.writeFile(tenantId, projectId, {
          path: POPUPS_PATH,
          content: input.yaml,
          author: input.author,
          message: 'popups: update',
        })
        await tx.update(projectFiles).set({ headCommit: commit }).where(current)
        return commit
      })
    },
  }
}

export type TestCasesRepo = ReturnType<typeof testCasesRepo>
