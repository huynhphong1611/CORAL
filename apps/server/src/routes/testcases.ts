import {
  api,
  validatePopupsSource,
  validateTestCaseSource,
  type ValidationIssue,
} from '@coral/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { HttpError, parseInput } from '../http/errors'
import type { Repos } from '../repos'
import type { TestCaseRow } from '../repos/test-cases'
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

function validTestCase(yaml: string, file: string) {
  const result = validateTestCaseSource(yaml, file)
  if (!result.valid || !result.value) throw invalid(result.errors)
  return { testCase: result.value, warnings: result.warnings.map(toIssue) }
}

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
    updated_at: iso(row.updatedAt),
  }) satisfies api.TestCaseSummary

const commitQuery = z.object({ commit: api.commitSha.optional() })
const projectParams = z.object({ id: z.uuid() })

/** Test cases and popup rules stored in the project's git repo (contracts/rest-api.md, D15). */
export function registerTestCaseRoutes(app: FastifyInstance, deps: { repos: Repos }): void {
  app.get('/projects/:id/testcases', async (request) => {
    const { id } = parseInput(projectParams, request.params)
    return (await scope(deps.repos, request).testCases.list(id)).map(toSummary)
  })

  app.post('/projects/:id/testcases', async (request, reply) => {
    const { id } = parseInput(projectParams, request.params)
    const { yaml } = parseInput(api.createTestCaseSchema, request.body)
    const s = scope(deps.repos, request)
    await s.projects.get(id)
    const { testCase, warnings } = validTestCase(yaml, 'testcase.yaml')
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
    const { testCase, warnings } = validTestCase(yaml, current.pathInRepo)
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
