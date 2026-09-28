import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { api, newId } from '@coral/shared'
import type { InjectOptions } from 'fastify'
import { hashPassword } from '../auth/password'
import { DEV_JWT_SECRET, loadConfig } from '../config'
import { createDatabase } from '../db/client'
import { ProjectRepoStore } from '../git/project-repo-store'
import { identityRepo } from '../repos/identity'
import { buildServer, type ServerDeps } from '../server'
import { createArtifactStore } from '../storage/s3'

export interface TestUser {
  email: string
  token: string
  tenantId: string
  userId: string
}

/**
 * A real server (Postgres, MinIO, git store in a temp dir) for *.int.test.ts, with helpers to
 * create users in fresh tenants and call the API as them.
 */
export async function startTestServer(extra: Partial<ServerDeps> = {}) {
  const config = loadConfig(process.env)
  const database = createDatabase(config.databaseUrl)
  const dataDir = await mkdtemp(join(tmpdir(), 'coral-server-'))
  const store = new ProjectRepoStore(dataDir)
  const artifacts = createArtifactStore(config.s3)
  await artifacts.ensureBucket()
  const deps: ServerDeps = { db: database.db, store, artifacts, ...extra }
  const app = buildServer({ logLevel: 'silent', jwtSecret: DEV_JWT_SECRET }, deps)
  await app.ready()

  /** Seeds a user in a brand-new tenant and logs in. */
  async function newUser(name = 'Huynh'): Promise<TestUser> {
    const email = `${name.toLowerCase()}-${newId()}@coral.test`
    const password = 'correct horse battery'
    const seeded = await identityRepo(database.db).seedOwner({
      email,
      passwordHash: await hashPassword(password),
      name,
      tenantName: `tenant of ${name}`,
    })
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password },
    })
    const session = api.sessionSchema.parse(res.json())
    return {
      email,
      token: session.access_token,
      tenantId: seeded.tenantId ?? '',
      userId: seeded.userId,
    }
  }

  /** `app.inject` as a user; returns status and parsed JSON. */
  async function call(user: TestUser, options: InjectOptions & { url: string }) {
    const res = await app.inject({
      ...options,
      headers: { ...options.headers, authorization: `Bearer ${user.token}` },
    })
    let body: unknown
    try {
      body = res.json()
    } catch {
      body = res.body
    }
    return { status: res.statusCode, body, res }
  }

  async function close() {
    await app.close()
    await database.close()
    await rm(dataDir, { recursive: true, force: true })
  }

  return { app, db: database.db, store, artifacts, config, dataDir, newUser, call, close }
}

export type TestServer = Awaited<ReturnType<typeof startTestServer>>
