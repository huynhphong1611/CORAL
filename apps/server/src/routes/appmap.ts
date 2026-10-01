import { posix } from 'node:path'
import { EMPTY_APPMAP, api } from '@coral/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { APPMAP_PATH, parseAppMap } from '../explorer/appmap'
import type { ProjectRepoStore } from '../git/project-repo-store'
import { notFound, parseInput } from '../http/errors'
import type { Repos } from '../repos'
import { scope } from './context'

/** Folders of the project repo `GET /projects/:id/files/*` serves (contracts/rest-api-phase3.md). */
const SERVED_DIRS = ['appmap/snap/', 'imports/'] as const

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json',
  '.yaml': 'text/yaml; charset=utf-8',
}

/** A normal path inside a served folder: no `..`, no `//`, nothing else of the repo (FR-042). */
export const isServedPath = (path: string) =>
  posix.normalize(path) === path &&
  !path.split('/').includes('..') &&
  SERVED_DIRS.some((dir) => path.startsWith(dir) && path.length > dir.length)

const fileUrl = (projectId: string, path: string, commit: string) =>
  `/projects/${projectId}/files/${path.split('/').map(encodeURIComponent).join('/')}?commit=${commit}`

const commitQuery = z.object({ commit: api.commitSha.optional() })

/**
 * The app map (US2, contracts/appmap.md) and the files the Explorer and the importer keep in the
 * project repo: `appmap/snap/<screen>/` pictures and `imports/` manual cases. Read-only, every
 * role of the tenant.
 */
export function registerAppMapRoutes(
  app: FastifyInstance,
  deps: { repos: Repos; store: ProjectRepoStore },
): void {
  app.get('/projects/:id/appmap', async (request) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    const { projects, auth } = scope(deps.repos, request)
    await projects.get(id)
    const head = await deps.store.head(auth.tenantId, id)
    const text = await deps.store.readFile(auth.tenantId, id, APPMAP_PATH, head)
    const map = text === null ? EMPTY_APPMAP : parseAppMap(text)
    return {
      schema: map.schema,
      head_commit: head,
      screens: map.screens.map((screen) => ({
        ...screen,
        screenshot_url: fileUrl(id, `${screen.snapshot}/screen.jpg`, head),
      })),
      transitions: map.transitions,
    } satisfies api.ProjectAppMap
  })

  /** One file of `appmap/snap/` or `imports/` at `?commit=` (default: head). */
  app.get('/projects/:id/files/*', async (request, reply) => {
    const { id, '*': path } = parseInput(
      z.object({ id: z.uuid(), '*': z.string() }),
      request.params,
    )
    const { commit } = parseInput(commitQuery, request.query)
    const { projects, auth } = scope(deps.repos, request)
    await projects.get(id)
    if (!isServedPath(path)) throw notFound('file')
    const bytes = await deps.store.readBytes(auth.tenantId, id, path, commit ?? 'HEAD')
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
}
