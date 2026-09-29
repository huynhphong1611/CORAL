import { api } from '@coral/shared'
import type { FastifyInstance } from 'fastify'
import { parseInput } from '../http/errors'
import type { Repos } from '../repos'
import type { AgentRow } from '../repos/agents'
import { deviceViews } from '../devices/views'
import { isoOrNull, scope } from './context'

/** Closes live agent connections; implemented by the WebSocket gateway. */
export interface AgentConnections {
  disconnect(agentId: string, code: number, reason: string): void
}

const toAgent = (a: AgentRow) => ({
  id: a.id,
  name: a.name,
  status: a.status,
  os: a.os,
  version: a.version,
  last_seen_at: isoOrNull(a.lastSeenAt),
})

/** POST/GET /agents, POST /agents/:id/revoke, GET /devices with activity (contracts/rest-api.md, rest-api-phase2.md). */
export function registerAgentRoutes(
  app: FastifyInstance,
  deps: { repos: Repos; connections?: AgentConnections },
): void {
  app.post('/agents', async (request, reply) => {
    const { name } = parseInput(api.createAgentSchema, request.body)
    const s = scope(deps.repos, request)
    const { agent, token } = await s.agents.create(name)
    await s.audit({ actor: `user:${s.auth.userId}`, action: 'agent.create', target: agent.id })
    return reply.status(201).send({ id: agent.id, name: agent.name, token })
  })

  app.get('/agents', async (request) =>
    (await scope(deps.repos, request).agents.list()).map(toAgent),
  )

  app.post('/agents/:id/revoke', async (request, reply) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    const s = scope(deps.repos, request)
    await s.agents.revoke(id)
    deps.connections?.disconnect(id, 4401, 'agent revoked')
    await s.audit({ actor: `user:${s.auth.userId}`, action: 'agent.revoke', target: id })
    return reply.status(204).send()
  })

  app.get('/devices', async (request) => deviceViews(scope(deps.repos, request)))
}
