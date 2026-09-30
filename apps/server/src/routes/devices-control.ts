import { api } from '@coral/shared'
import type { FastifyInstance } from 'fastify'
import { notFound, parseInput } from '../http/errors'
import type { LiveControl } from '../live/control'
import type { Repos } from '../repos'
import { scope } from './context'

/**
 * `POST|GET|DELETE /devices/:id/control` (contracts/rest-api-phase2.md, US3): taking and letting
 * go of a device from the browser. POST and DELETE need a writer role (the guard refuses viewers).
 */
export function registerControlRoutes(
  app: FastifyInstance,
  deps: { repos: Repos; live: LiveControl },
): void {
  app.post('/devices/:id/control', async (request, reply) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    const s = scope(deps.repos, request)
    const session = await deps.live.take(s.auth, id)
    await s.audit({ actor: `user:${s.auth.userId}`, action: 'device.control', target: id })
    return reply.status(201).send(session)
  })

  app.get('/devices/:id/control', async (request) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    const s = scope(deps.repos, request)
    const session = await deps.live.current(s.auth.tenantId, id)
    if (!session) throw notFound('control session')
    return session
  })

  app.delete('/devices/:id/control', async (request, reply) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    const s = scope(deps.repos, request)
    await deps.live.release(s.auth, id)
    await s.audit({ actor: `user:${s.auth.userId}`, action: 'device.release', target: id })
    return reply.status(204).send()
  })
}
