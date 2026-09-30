import { api } from '@coral/shared'
import type { FastifyInstance } from 'fastify'
import { parseInput } from '../http/errors'
import type { Repos } from '../repos'
import { gitAuthor, iso, scope } from './context'

type ProjectRow = { id: string; name: string; createdAt: Date }
type AppRow = {
  id: string
  projectId: string
  platform: string
  packageOrBundleId: string
  name: string
  createdAt: Date
}

const toProject = (p: ProjectRow) =>
  ({ id: p.id, name: p.name, created_at: iso(p.createdAt) }) satisfies api.Project

const toApp = (a: AppRow) =>
  ({
    id: a.id,
    project_id: a.projectId,
    platform: 'android',
    package_or_bundle_id: a.packageOrBundleId,
    name: a.name,
    created_at: iso(a.createdAt),
  }) satisfies api.App

/** GET/POST /projects, GET/POST /projects/:id/apps (contracts/rest-api.md). */
export function registerProjectRoutes(app: FastifyInstance, deps: { repos: Repos }): void {
  app.get('/projects', async (request) => {
    const { projects } = scope(deps.repos, request)
    return (await projects.list()).map(toProject)
  })

  app.post('/projects', async (request, reply) => {
    const { name } = parseInput(api.createProjectSchema, request.body)
    const s = scope(deps.repos, request)
    const project = await s.projects.create(name, await gitAuthor(deps.repos, s.auth))
    await s.audit({ actor: `user:${s.auth.userId}`, action: 'project.create', target: project.id })
    return reply.status(201).send(toProject(project))
  })

  app.get('/projects/:id/apps', async (request) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    return (await scope(deps.repos, request).projects.listApps(id)).map(toApp)
  })

  app.post('/projects/:id/apps', async (request, reply) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    const body = parseInput(api.createAppSchema, request.body)
    const created = await scope(deps.repos, request).projects.createApp(id, {
      platform: body.platform,
      packageOrBundleId: body.package_or_bundle_id,
      name: body.name,
    })
    return reply.status(201).send(toApp(created))
  })
}
