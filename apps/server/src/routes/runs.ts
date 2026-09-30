import { api } from '@coral/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { conflict, parseInput } from '../http/errors'
import type { Repos } from '../repos'
import type { RunItemRow, RunRow, RunStepRow } from '../repos/runs'
import { createRun, type CreateRunDeps } from '../runs/create'
import type { RunDispatcher } from '../runs/dispatcher'
import { stepArtifactKey } from '../storage/keys'
import type { ArtifactStore } from '../storage/s3'
import { iso, isoOrNull, scope } from './context'

export interface RunRouteDeps extends CreateRunDeps {
  repos: Repos
  artifacts: ArtifactStore
  dispatcher: Pick<RunDispatcher, 'cancel'>
}

const toItem = (item: RunItemRow, slug?: string) => ({
  id: item.id,
  test_case_id: item.testCaseId,
  ...(slug === undefined ? {} : { slug }),
  commit: item.commit,
  position: item.position,
  status: item.status,
  failure_code: item.failureCode as api.RunItem['failure_code'],
  failed_step_id: item.failedStepId,
})

const toRun = (run: RunRow, items: ReturnType<typeof toItem>[]) =>
  ({
    id: run.id,
    project_id: run.projectId,
    build_id: run.buildId,
    device_id: run.deviceId,
    status: run.status,
    failure_code: run.failureCode as api.Run['failure_code'],
    queued_at: iso(run.queuedAt),
    started_at: isoOrNull(run.startedAt),
    finished_at: isoOrNull(run.finishedAt),
    items,
  }) satisfies api.Run

const itemParams = z.object({ id: z.uuid(), itemId: z.uuid() })

/** Runs (contracts/rest-api.md): create, list, read, cancel, steps with presigned artifacts. */
export function registerRunRoutes(app: FastifyInstance, deps: RunRouteDeps): void {
  app.post('/runs', async (request, reply) => {
    const input = parseInput(api.createRunSchema, request.body)
    const { run, items } = await createRun(scope(deps.repos, request), input, deps)
    return reply.status(201).send({
      id: run.id,
      status: 'queued',
      items: items.map((i) => ({
        id: i.id,
        test_case_id: i.testCaseId,
        commit: i.commit,
        position: i.position,
      })),
    })
  })

  app.get('/runs', async (request) => {
    const query = parseInput(api.listRunsQuerySchema, request.query)
    const { runs } = scope(deps.repos, request)
    const page = await runs.list({
      limit: query.limit,
      ...(query.project_id ? { projectId: query.project_id } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.device_id ? { deviceId: query.device_id } : {}),
      ...(query.test_case_id ? { testCaseId: query.test_case_id } : {}),
      ...(query.cursor ? { cursor: parseInput(z.uuid(), query.cursor) } : {}),
    })
    const items = await Promise.all(
      page.rows.map(async (run) =>
        toRun(
          run,
          (await runs.items(run.id)).map((r) => toItem(r.item, r.slug)),
        ),
      ),
    )
    return { items, next_cursor: page.nextCursor }
  })

  app.get('/runs/:id', async (request) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    const { runs } = scope(deps.repos, request)
    const run = await runs.get(id)
    return toRun(
      run,
      (await runs.items(id)).map((r) => toItem(r.item, r.slug)),
    )
  })

  app.post('/runs/:id/cancel', async (request, reply) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    const s = scope(deps.repos, request)
    const run = await s.runs.get(id)
    const outcome = await deps.dispatcher.cancel(run, 'cancelled by user')
    if (outcome === 'finished') throw conflict('run_finished', `run is already ${run.status}`)
    await s.audit({ actor: `user:${s.auth.userId}`, action: 'run.cancel', target: id })
    return reply
      .status(202)
      .send({ id, status: outcome === 'cancelled' ? 'cancelled' : run.status })
  })

  app.get('/runs/:id/items/:itemId/steps', async (request) => {
    const { id, itemId } = parseInput(itemParams, request.params)
    const { runs } = scope(deps.repos, request)
    await runs.get(id)
    const steps = await runs.steps(id, itemId)
    const url = async (key: string) => (await deps.artifacts.presignGet(key)).url
    return Promise.all(
      steps.map(
        async (step: RunStepRow) =>
          ({
            step_index: step.stepIndex,
            step_id: step.stepId,
            action: step.action,
            status: step.status,
            locator_used_index: step.locatorUsedIndex,
            degraded: step.degraded,
            unstable: step.unstable,
            duration_ms: step.durationMs,
            failure_code: step.failureCode as api.RunStep['failure_code'],
            message: step.message,
            popups_handled: step.popupsHandled as api.RunStep['popups_handled'],
            artifacts: {
              screenshot_url: await url(stepArtifactKey(step.artifactPrefix, 'screenshot.png')),
              tree_url: await url(stepArtifactKey(step.artifactPrefix, 'tree.json')),
              // The device log is only captured when a step fails (§8.6).
              log_url:
                step.status === 'failed'
                  ? await url(stepArtifactKey(step.artifactPrefix, 'device.log'))
                  : null,
            },
          }) satisfies api.RunStep,
      ),
    )
  })
}
