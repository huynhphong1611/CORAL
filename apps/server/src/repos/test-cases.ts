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
/** The Recorder's snapshots of a test case (data-model §4). */
export const snapshotDir = (slug: string) => `snap/${slug}`

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
    async list(
      projectId: string,
      filter: { source?: TestCaseRow['source']; status?: TestCaseRow['status'] } = {},
    ) {
      await projects.get(projectId)
      return db
        .select()
        .from(testCases)
        .where(
          and(
            inTenant,
            eq(testCases.projectId, projectId),
            filter.source ? eq(testCases.source, filter.source) : undefined,
            filter.status ? eq(testCases.status, filter.status) : undefined,
          ),
        )
        .orderBy(asc(testCases.slug))
    },

    /**
     * Status and its reasons, which live only in the DB (D15): a person's PATCH, or the result of
     * the validation runs of an AI-written test case (D41).
     */
    async setStatus(
      id: string,
      patch: {
        status: TestCaseRow['status']
        draftReason?: TestCaseRow['draftReason']
        flags?: TestCaseRow['flags']
        validation?: TestCaseRow['validation']
        validatedAt?: Date | null
        userId?: string
      },
    ): Promise<TestCaseRow> {
      const { userId, ...columns } = patch
      const [row] = await db
        .update(testCases)
        .set({
          ...columns,
          // Leaving draft clears why it was a draft.
          ...(patch.status !== 'draft' && patch.draftReason === undefined
            ? { draftReason: null }
            : {}),
          ...(userId ? { updatedBy: userId } : {}),
          updatedAt: new Date(),
        })
        .where(and(inTenant, eq(testCases.id, id)))
        .returning()
      if (!row) throw notFound('test case')
      return row
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

    /** Paths under the test case's `snap/<slug>/` at `commit` (default: head). */
    snapshotFiles(row: TestCaseRow, commit?: string): Promise<string[]> {
      return store.listFiles(
        tenantId,
        row.projectId,
        snapshotDir(row.slug),
        commit ?? row.headCommit,
      )
    },

    /** Bytes of a repo file at `commit` (default: head), or null; the caller checks the path. */
    readBytes(row: TestCaseRow, path: string, commit?: string): Promise<Buffer | null> {
      return store.readBytes(tenantId, row.projectId, path, commit ?? row.headCommit)
    },

    /** Which of `paths` are in the project repo now (image references, FR-022). */
    existingFiles(projectId: string, paths: readonly string[]): Promise<Set<string>> {
      return store.existingFiles(tenantId, projectId, paths)
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

    /**
     * A test case from the Recorder (FR-017): the YAML and its `snap/<slug>/` folder in one commit,
     * `source = recorder`. With `replace`, the existing test case of that slug is overwritten when
     * its head is still `baseCommit` (409 otherwise) and its old snapshots go in the same commit.
     */
    async saveRecorded(
      projectId: string,
      input: {
        testCase: TestCase
        yaml: string
        snapshots: Record<string, Uint8Array | string>
        author: GitAuthor
        userId: string
        replace?: { id: string; baseCommit: string }
      },
    ): Promise<TestCaseRow> {
      await projects.get(projectId)
      const { testCase } = input
      const pathInRepo = testCasePath(testCase.id)
      const commitAll = () =>
        store.commitFiles(tenantId, projectId, {
          files: { [pathInRepo]: input.yaml, ...input.snapshots },
          removeDirs: [snapshotDir(testCase.id)],
          author: input.author,
          message: `testcase: ${testCase.id} (recorder)`,
        })
      const meta = {
        intent: testCase.intent,
        tags: testCase.tags ?? [],
        platforms: [...testCase.platforms],
        source: 'recorder' as const,
        updatedBy: input.userId,
      }
      if (input.replace) {
        const { id, baseCommit } = input.replace
        return db.transaction(async (tx) => {
          const [locked] = await tx
            .update(testCases)
            .set({ updatedAt: new Date() })
            .where(
              and(
                inTenant,
                eq(testCases.id, id),
                eq(testCases.slug, testCase.id),
                eq(testCases.headCommit, baseCommit),
              ),
            )
            .returning()
          if (!locked) throw conflict('stale_base_commit', 'test case changed since base_commit')
          const commit = await commitAll()
          const [saved] = await tx
            .update(testCases)
            .set({ ...meta, headCommit: commit, updatedAt: new Date() })
            .where(eq(testCases.id, id))
            .returning()
          if (!saved) throw new Error('test case not stored')
          return saved
        })
      }
      try {
        return await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(testCases)
            .values({
              tenantId,
              projectId,
              slug: testCase.id,
              pathInRepo,
              headCommit: PENDING_COMMIT,
              ...meta,
            })
            .returning()
          if (!row) throw new Error('test case not stored')
          const commit = await commitAll()
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
          throw conflict('slug_exists', `test case "${testCase.id}" already exists`)
        }
        throw error
      }
    },

    /** The test case of a slug in the project, if any. */
    async bySlug(projectId: string, slug: string): Promise<TestCaseRow | undefined> {
      const [row] = await db
        .select()
        .from(testCases)
        .where(and(inTenant, eq(testCases.projectId, projectId), eq(testCases.slug, slug)))
      return row
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
