import { api } from '@coral/shared'
import type { FastifyInstance } from 'fastify'
import type { ExplorationService } from '../explorer/service'
import { parseInput } from '../http/errors'
import type { Repos } from '../repos'
import { scope } from './context'

/**
 * Explorations over REST (contracts/rest-api-phase3.md, US2): start one on a device, follow it
 * (list, detail with its app map, trace), stop it. Progress is also pushed over `/ws/ui`
 * (`exploration.watch`). Starting and stopping need a writer role (the guard refuses viewers).
 */
export function registerExplorationRoutes(
  app: FastifyInstance,
  deps: { repos: Repos; explorations: ExplorationService },
): void {
  const { explorations } = deps

  app.post('/explorations', async (request, reply) => {
    const input = parseInput(api.createExplorationSchema, request.body)
    const s = scope(deps.repos, request)
    const exploration = await explorations.start(s.auth, input)
    await s.audit({
      actor: `user:${s.auth.userId}`,
      action: 'exploration.start',
      target: exploration.id,
      meta: { device_id: input.device_id, build_id: input.build_id, kind: exploration.kind },
    })
    return reply.status(201).send(exploration)
  })

  app.get('/explorations', async (request) => {
    const query = parseInput(api.listExplorationsQuerySchema, request.query)
    return explorations.list(scope(deps.repos, request).auth.tenantId, query)
  })

  app.get('/explorations/:id', async (request) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    return explorations.detail(scope(deps.repos, request).auth.tenantId, id)
  })

  app.get('/explorations/:id/steps', async (request) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    const query = parseInput(api.explorationStepsQuerySchema, request.query)
    return explorations.steps(scope(deps.repos, request).auth.tenantId, id, query)
  })

  app.post('/explorations/:id/stop', async (request, reply) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    const s = scope(deps.repos, request)
    const exploration = await explorations.stop(s.auth.tenantId, id)
    await s.audit({ actor: `user:${s.auth.userId}`, action: 'exploration.stop', target: id })
    return reply.status(202).send(exploration)
  })
}
