import { createHash } from 'node:crypto'
import { Transform } from 'node:stream'
import { api, newId } from '@coral/shared'
import type { FastifyInstance } from 'fastify'
import { HttpError, parseInput } from '../http/errors'
import type { Repos } from '../repos'
import type { BuildRow } from '../repos/builds'
import { buildKey } from '../storage/keys'
import type { ArtifactStore } from '../storage/s3'
import { iso, scope } from './context'

export const APK_CONTENT_TYPE = 'application/vnd.android.package-archive'

const versionSchema = api.createProjectSchema.shape.name

const toBuild = (b: BuildRow) =>
  ({
    id: b.id,
    app_id: b.appId,
    version: b.version,
    checksum_sha256: b.checksumSha256,
    size_bytes: b.sizeBytes,
    created_at: iso(b.createdAt),
  }) satisfies api.Build

/** Streams the upload to S3 while hashing and counting it (research R11). */
function hashing() {
  const hash = createHash('sha256')
  let size = 0
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk)
      size += chunk.length
      done(null, chunk)
    },
  })
  return { stream, result: () => ({ sha256: hash.digest('hex'), size }) }
}

/** POST/GET /apps/:id/builds — multipart `file` (.apk) + `version` (contracts/rest-api.md). */
export function registerBuildRoutes(
  app: FastifyInstance,
  deps: { repos: Repos; artifacts: ArtifactStore },
): void {
  app.get('/apps/:id/builds', async (request) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    const s = scope(deps.repos, request)
    await s.projects.getApp(id)
    return (await s.builds.list(id)).map(toBuild)
  })

  app.post('/apps/:id/builds', async (request, reply) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    const s = scope(deps.repos, request)
    const appRow = await s.projects.getApp(id)
    if (!request.isMultipart()) {
      throw new HttpError(400, 'validation_failed', 'expected multipart/form-data')
    }
    const buildId = newId()
    const key = buildKey(s.tenantId, buildId)
    let version: string | undefined
    let uploaded: { sha256: string; size: number } | undefined
    try {
      for await (const part of request.parts()) {
        if (part.type === 'field') {
          if (part.fieldname === 'version') version = String(part.value as string)
          continue
        }
        if (part.fieldname !== 'file' || uploaded) {
          part.file.resume()
          throw new HttpError(400, 'validation_failed', 'send exactly one file field named "file"')
        }
        if (!part.filename.toLowerCase().endsWith('.apk')) {
          part.file.resume()
          throw new HttpError(400, 'validation_failed', 'only .apk builds are accepted in Phase 1')
        }
        const counter = hashing()
        part.file.on('error', (error) => counter.stream.destroy(error))
        await deps.artifacts.putStream(key, part.file.pipe(counter.stream), APK_CONTENT_TYPE)
        uploaded = counter.result()
      }
      if (!uploaded) throw new HttpError(400, 'validation_failed', 'missing file field "file"')
      const parsedVersion = versionSchema.safeParse(version)
      if (!parsedVersion.success) {
        throw new HttpError(400, 'validation_failed', 'missing or invalid field "version"')
      }
      const build = await s.builds.create({
        id: buildId,
        appId: appRow.id,
        version: parsedVersion.data,
        artifactKey: key,
        checksumSha256: uploaded.sha256,
        sizeBytes: uploaded.size,
        uploadedBy: s.auth.userId,
      })
      await s.audit({ actor: `user:${s.auth.userId}`, action: 'build.upload', target: build.id })
      return await reply.status(201).send(toBuild(build))
    } catch (error) {
      // No half-uploaded or orphaned build objects (413, bad fields, DB errors).
      await deps.artifacts.remove(key).catch(() => undefined)
      throw error
    }
  })
}
