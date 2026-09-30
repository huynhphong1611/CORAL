import { api } from '@coral/shared'
import type { FastifyInstance } from 'fastify'
import { parseInput } from '../http/errors'
import type { RecordingService } from '../recordings/service'
import type { Repos } from '../repos'
import { gitAuthor, scope } from './context'

/**
 * The Recorder's REST side (contracts/rest-api-phase2.md, US4): start, read, edit, stop, resume,
 * preview and discard recordings; steps are recorded over `/ws/ui`. Writes need a writer role
 * (the guard refuses viewers) and only the person who recorded may change a recording.
 */
export function registerRecordingRoutes(
  app: FastifyInstance,
  deps: { repos: Repos; recordings: RecordingService },
): void {
  const { recordings } = deps

  app.post('/recordings', async (request, reply) => {
    const input = parseInput(api.createRecordingSchema, request.body)
    const s = scope(deps.repos, request)
    const recording = await recordings.start(s.auth, input)
    await s.audit({
      actor: `user:${s.auth.userId}`,
      action: 'recording.start',
      target: recording.id,
      meta: { device_id: input.device_id, build_id: input.build_id },
    })
    return reply.status(201).send(recording)
  })

  app.get('/recordings', async (request) => {
    const query = parseInput(api.listRecordingsQuerySchema, request.query)
    return recordings.list(scope(deps.repos, request).auth.tenantId, query)
  })

  app.get('/recordings/:id', async (request) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    return recordings.get(scope(deps.repos, request).auth.tenantId, id)
  })

  app.patch('/recordings/:id', async (request) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    const input = parseInput(api.patchRecordingSchema, request.body)
    return recordings.patch(scope(deps.repos, request).auth, id, input)
  })

  app.post('/recordings/:id/stop', async (request) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    return recordings.stop(scope(deps.repos, request).auth, id)
  })

  app.post('/recordings/:id/resume', async (request) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    return recordings.resume(scope(deps.repos, request).auth, id)
  })

  app.get('/recordings/:id/yaml', async (request) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    return recordings.yaml(scope(deps.repos, request).auth.tenantId, id)
  })

  app.post('/recordings/:id/save', async (request, reply) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    const input = parseInput(api.saveRecordingSchema, request.body)
    const s = scope(deps.repos, request)
    const author = await gitAuthor(deps.repos, s.auth)
    const saved = await recordings.save({ ...s.auth, author }, id, input)
    await s.audit({
      actor: `user:${s.auth.userId}`,
      action: 'recording.save',
      target: id,
      meta: { test_case_id: saved.test_case_id, slug: input.slug },
    })
    return reply.status(201).send(saved)
  })

  app.delete('/recordings/:id', async (request, reply) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    const s = scope(deps.repos, request)
    await recordings.discard(s.auth, id)
    await s.audit({ actor: `user:${s.auth.userId}`, action: 'recording.discard', target: id })
    return reply.status(204).send()
  })
}
