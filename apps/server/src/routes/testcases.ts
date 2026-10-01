import { posix } from 'node:path'
import {
  api,
  imagePaths,
  validatePopupsSource,
  validateTestCaseSource,
  type ValidationIssue,
} from '@coral/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { HttpError, notFound, parseInput } from '../http/errors'
import type { Repos } from '../repos'
import { snapshotDir, type TestCaseRow } from '../repos/test-cases'
import { stepArtifactKey } from '../storage/keys'
import type { ArtifactStore } from '../storage/s3'
import { gitAuthor, iso, scope } from './context'

const toIssue = (issue: ValidationIssue) => ({
  path: issue.path,
  code: issue.code,
  message: issue.message,
  ...(issue.step_id === undefined ? {} : { step_id: issue.step_id }),
  ...(issue.line === undefined ? {} : { line: issue.line }),
  ...(issue.column === undefined ? {} : { column: issue.column }),
})

/** 400 `validation_failed` with the same problems `coral validate` reports (US1, FR-003). */
function invalid(errors: ValidationIssue[]): HttpError {
  return new HttpError(400, 'validation_failed', 'YAML is not valid', errors.map(toIssue))
}

/**
 * Validates like `coral validate`; `existing` answers which referenced images are in the project
 * repo, so a missing one is `image_not_found` (FR-022).
 */
async function validTestCase(
  yaml: string,
  file: string,
  existing: (paths: string[]) => Promise<Set<string>>,
) {
  let result = validateTestCaseSource(yaml, file)
  if (!result.valid || !result.value) throw invalid(result.errors)
  const images = imagePaths(result.value)
  if (images.length > 0) {
    const found = await existing(images)
    result = validateTestCaseSource(yaml, file, { fileExists: (path) => found.has(path) })
    if (!result.valid || !result.value) throw invalid(result.errors)
  }
  return { testCase: result.value, warnings: result.warnings.map(toIssue) }
}

/** Snapshot files are served by extension; anything else is plain bytes. */
const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json',
}

/** A path inside the test case's `snap/<slug>/`, already normal (no `..`, no `//`, FR-019). */
const isSnapshotPath = (slug: string, path: string) =>
  posix.normalize(path) === path &&
  path.startsWith(`${snapshotDir(slug)}/`) &&
  !path.split('/').includes('..')

/** The route that serves a snapshot file at a commit (relative to the API root). */
const fileUrl = (id: string, path: string, commit: string) =>
  `/testcases/${id}/files/${path.split('/').map(encodeURIComponent).join('/')}?commit=${commit}`

const toSummary = (row: TestCaseRow) =>
  ({
    id: row.id,
    slug: row.slug,
    intent: row.intent,
    tags: row.tags,
    platforms: row.platforms,
    status: row.status,
    head_commit: row.headCommit,
    source: row.source,
    source_ref: row.sourceRef,
    // The validation columns arrive with the Phase 3 migration (T012–T013).
    draft_reason: null,
    flags: [],
    validation: null,
    updated_at: iso(row.updatedAt),
  }) satisfies api.TestCaseSummary

const commitQuery = z.object({ commit: api.commitSha.optional() })
const projectParams = z.object({ id: z.uuid() })

/** Test cases and popup rules stored in the project's git repo (contracts/rest-api.md, D15). */
export function registerTestCaseRoutes(
  app: FastifyInstance,
  deps: { repos: Repos; artifacts?: ArtifactStore },
): void {
  app.get('/projects/:id/testcases', async (request) => {
    const { id } = parseInput(projectParams, request.params)
    return (await scope(deps.repos, request).testCases.list(id)).map(toSummary)
  })

  app.post('/projects/:id/testcases', async (request, reply) => {
    const { id } = parseInput(projectParams, request.params)
    const { yaml } = parseInput(api.createTestCaseSchema, request.body)
    const s = scope(deps.repos, request)
    await s.projects.get(id)
    const { testCase, warnings } = await validTestCase(yaml, 'testcase.yaml', (paths) =>
      s.testCases.existingFiles(id, paths),
    )
    const row = await s.testCases.create(id, {
      testCase,
      yaml,
      author: await gitAuthor(deps.repos, s.auth),
      userId: s.auth.userId,
    })
    await s.audit({ actor: `user:${s.auth.userId}`, action: 'testcase.create', target: row.id })
    return reply.status(201).send({
      id: row.id,
      slug: row.slug,
      head_commit: row.headCommit,
      warnings,
    } satisfies api.SavedTestCase)
  })

  app.get('/testcases/:id', async (request) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    const { commit } = parseInput(commitQuery, request.query)
    const { testCases } = scope(deps.repos, request)
    const row = await testCases.get(id)
    return {
      ...toSummary(row),
      yaml: await testCases.readYaml(row, commit),
    } satisfies api.TestCaseDetail
  })

  app.put('/testcases/:id', async (request) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    const { yaml, base_commit } = parseInput(api.updateTestCaseSchema, request.body)
    const s = scope(deps.repos, request)
    const current = await s.testCases.get(id)
    const { testCase, warnings } = await validTestCase(yaml, current.pathInRepo, (paths) =>
      s.testCases.existingFiles(current.projectId, paths),
    )
    const row = await s.testCases.update(id, {
      testCase,
      yaml,
      baseCommit: base_commit,
      author: await gitAuthor(deps.repos, s.auth),
      userId: s.auth.userId,
    })
    return { head_commit: row.headCommit, warnings }
  })

  app.get('/testcases/:id/history', async (request) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    const { testCases } = scope(deps.repos, request)
    const history = await testCases.history(await testCases.get(id))
    return history.map(
      (h) =>
        ({
          commit: h.commit,
          author: `${h.author.name} <${h.author.email}>`,
          message: h.message,
          created_at: iso(h.createdAt),
        }) satisfies api.HistoryEntry,
    )
  })

  // --- editor pictures (FR-019) ------------------------------------------------------------

  /** The Recorder's snapshot of each step at the head commit (`snap/<slug>/<step_id>/`). */
  app.get('/testcases/:id/snapshots', async (request) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    const { testCases } = scope(deps.repos, request)
    const row = await testCases.get(id)
    const files = new Set(await testCases.snapshotFiles(row))
    const steps = new Set(
      [...files].map((path) => path.slice(snapshotDir(row.slug).length + 1).split('/')[0] ?? ''),
    )
    const url = (path: string) => fileUrl(row.id, path, row.headCommit)
    return [...steps].flatMap((stepId) => {
      const dir = `${snapshotDir(row.slug)}/${stepId}`
      if (!files.has(`${dir}/screen.jpg`) || !files.has(`${dir}/tree.json`)) return []
      return [
        {
          step_id: stepId,
          screen_url: url(`${dir}/screen.jpg`),
          tree_url: url(`${dir}/tree.json`),
          element_url: files.has(`${dir}/element.png`) ? url(`${dir}/element.png`) : null,
        },
      ]
    }) satisfies z.infer<typeof api.testCaseSnapshotsSchema>
  })

  /** One file of the test case's snapshots at `?commit=` (default: head); nothing else. */
  app.get('/testcases/:id/files/*', async (request, reply) => {
    const { id, '*': path } = parseInput(
      z.object({ id: z.uuid(), '*': z.string() }),
      request.params,
    )
    const { commit } = parseInput(commitQuery, request.query)
    const { testCases } = scope(deps.repos, request)
    const row = await testCases.get(id)
    if (!isSnapshotPath(row.slug, path)) throw notFound('file')
    const bytes = await testCases.readBytes(row, path, commit)
    if (!bytes) throw notFound('file')
    return reply
      .header(
        'content-type',
        CONTENT_TYPES[posix.extname(path).toLowerCase()] ?? 'application/octet-stream',
      )
      .header('x-content-type-options', 'nosniff')
      .header(
        'cache-control',
        // A file at a given commit never changes.
        commit ? 'private, max-age=31536000, immutable' : 'private, no-cache',
      )
      .send(bytes)
  })

  /** Step screenshots of the latest run of the test case: the editor's fallback picture. */
  app.get('/testcases/:id/last-run-steps', async (request) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    const { testCases, runs } = scope(deps.repos, request)
    await testCases.get(id)
    const { artifacts } = deps
    const last = artifacts ? await runs.lastItemSteps(id) : undefined
    if (!artifacts || !last?.item.finishedAt) return []
    const finishedAt = iso(last.item.finishedAt)
    return Promise.all(
      last.steps.map(async (step) => ({
        step_id: step.stepId,
        screenshot_url: (
          await artifacts.presignGet(stepArtifactKey(step.artifactPrefix, 'screenshot.png'))
        ).url,
        run_id: last.item.runId,
        finished_at: finishedAt,
      })),
    ) satisfies Promise<z.infer<typeof api.lastRunStepsSchema>>
  })

  app.get('/projects/:id/popups', async (request) => {
    const { id } = parseInput(projectParams, request.params)
    const { commit } = parseInput(commitQuery, request.query)
    const popups = await scope(deps.repos, request).testCases.readPopups(id, commit)
    return { yaml: popups.yaml, head_commit: popups.headCommit } satisfies api.PopupsFile
  })

  app.put('/projects/:id/popups', async (request) => {
    const { id } = parseInput(projectParams, request.params)
    const { yaml, base_commit } = parseInput(api.updatePopupsSchema, request.body)
    const s = scope(deps.repos, request)
    await s.projects.get(id)
    const result = validatePopupsSource(yaml, 'popups.yaml')
    if (!result.valid) throw invalid(result.errors)
    const commit = await s.testCases.updatePopups(id, {
      yaml,
      baseCommit: base_commit,
      author: await gitAuthor(deps.repos, s.auth),
    })
    await s.audit({ actor: `user:${s.auth.userId}`, action: 'popups.update', target: id })
    return { head_commit: commit }
  })
}
