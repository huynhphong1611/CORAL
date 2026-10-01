import { api, MAX_IMPORT_BYTES } from '@coral/shared'
import type { FastifyInstance } from 'fastify'
import { HttpError, parseInput } from '../http/errors'
import type { ImportService } from '../imports/service'
import type { Repos } from '../repos'
import { gitAuthor, scope } from './context'

/**
 * Imports of manual test cases over REST (contracts/rest-api-phase3.md, US6): upload a file and
 * get its preview, choose the columns, start, follow, cancel, or drop a preview. Progress is also
 * pushed over `/ws/ui` (`import.watch`). Changes need a writer role (the guard refuses viewers).
 */
export function registerImportRoutes(
  app: FastifyInstance,
  deps: { repos: Repos; imports: ImportService },
): void {
  const { imports } = deps

  app.post('/projects/:id/imports', async (request, reply) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    const s = scope(deps.repos, request)
    if (!request.isMultipart()) {
      throw new HttpError(400, 'validation_failed', 'expected multipart/form-data')
    }
    const fields: Record<string, string> = {}
    let file: { fileName: string; bytes: Uint8Array } | undefined
    for await (const part of request.parts({ limits: { fileSize: MAX_IMPORT_BYTES } })) {
      if (part.type === 'field') {
        fields[part.fieldname] = String(part.value)
        continue
      }
      if (part.fieldname !== 'file' || file) {
        part.file.resume()
        throw new HttpError(400, 'validation_failed', 'send exactly one file field named "file"')
      }
      file = { fileName: part.filename, bytes: new Uint8Array(await part.toBuffer()) }
    }
    if (!file) throw new HttpError(400, 'validation_failed', 'missing file field "file"')
    const options = parseInput(api.createImportFieldsSchema, fields)
    const preview = await imports.create(s.auth, id, {
      ...file,
      ...(options.format ? { format: options.format } : {}),
      ...(options.sheet ? { sheet: options.sheet } : {}),
    })
    await s.audit({
      actor: `user:${s.auth.userId}`,
      action: 'import.upload',
      target: preview.import_job_id,
      meta: { project_id: id, format: preview.format, cases: preview.cases.length },
    })
    return reply.status(201).send(preview)
  })

  app.patch('/imports/:id', async (request) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    const { mapping } = parseInput(api.patchImportSchema, request.body)
    return imports.remap(scope(deps.repos, request).auth.tenantId, id, mapping)
  })

  app.post('/imports/:id/start', async (request, reply) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    const input = parseInput(api.startImportSchema, request.body)
    const s = scope(deps.repos, request)
    const job = await imports.start(s.auth, id, input, await gitAuthor(deps.repos, s.auth))
    await s.audit({
      actor: `user:${s.auth.userId}`,
      action: 'import.start',
      target: id,
      meta: { device_id: input.device_id, build_id: input.build_id, cases: job.stats.total },
    })
    return reply.status(202).send(job)
  })

  app.get('/imports', async (request) => {
    const { project_id } = parseInput(api.listImportsQuerySchema, request.query)
    return imports.list(scope(deps.repos, request).auth.tenantId, project_id)
  })

  app.get('/imports/:id', async (request) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    return imports.detail(scope(deps.repos, request).auth.tenantId, id)
  })

  app.post('/imports/:id/cancel', async (request, reply) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    const s = scope(deps.repos, request)
    const job = await imports.cancel(s.auth.tenantId, id)
    await s.audit({ actor: `user:${s.auth.userId}`, action: 'import.cancel', target: id })
    return reply.status(202).send(job)
  })

  app.delete('/imports/:id', async (request, reply) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    const s = scope(deps.repos, request)
    await imports.remove(s.auth.tenantId, id)
    return reply.status(204).send()
  })
}
