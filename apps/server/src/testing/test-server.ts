import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { api, newId, type LogLevel } from '@coral/shared'
import type { InjectOptions } from 'fastify'
import { hashPassword } from '../auth/password'
import { DEV_JWT_SECRET, loadConfig } from '../config'
import { createDatabase } from '../db/client'
import { ProjectRepoStore } from '../git/project-repo-store'
import { identityRepo } from '../repos/identity'
import { buildServer, type ServerDeps } from '../server'
import { createArtifactStore } from '../storage/s3'

/** Password of every user created by newUser(). */
export const TEST_PASSWORD = 'correct horse battery'

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
export async function startTestServer(
  extra:
    | Partial<ServerDeps>
    | ((
        base: Required<Pick<ServerDeps, 'db' | 'store' | 'artifacts'>>,
      ) => Partial<ServerDeps>) = {},
  logging: { level?: LogLevel; stream?: { write(line: string): void } } = {},
) {
  const config = loadConfig(process.env)
  const database = createDatabase(config.databaseUrl)
  const dataDir = await mkdtemp(join(tmpdir(), 'coral-server-'))
  const store = new ProjectRepoStore(dataDir)
  const artifacts = createArtifactStore(config.s3)
  await artifacts.ensureBucket()
  const base = { db: database.db, store, artifacts }
  const deps: ServerDeps = { ...base, ...(typeof extra === 'function' ? extra(base) : extra) }
  const app = buildServer(
    {
      logLevel: logging.level ?? 'silent',
      jwtSecret: DEV_JWT_SECRET,
      ...(logging.stream ? { logStream: logging.stream } : {}),
    },
    deps,
  )
  await app.ready()

  /** Seeds a user in a brand-new tenant and logs in. */
  async function newUser(name = 'Huynh'): Promise<TestUser> {
    const email = `${name.toLowerCase()}-${newId()}@coral.test`
    const password = TEST_PASSWORD
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

  /** Creates an agent through the API; returns its id and one-time token. */
  async function newAgent(user: TestUser, name = 'agent') {
    const res = await call(user, { method: 'POST', url: '/agents', payload: { name } })
    return api.createdAgentSchema.parse(res.body)
  }

  /** Listens on a random local port (needed for WebSocket tests); returns the base URL. */
  async function listen(): Promise<string> {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    return address
  }

  async function close() {
    await app.close()
    await database.close()
    await rm(dataDir, { recursive: true, force: true })
  }

  return {
    app,
    db: database.db,
    store,
    artifacts,
    config,
    dataDir,
    deps,
    newUser,
    newAgent,
    call,
    listen,
    close,
  }
}

export type TestServer = Awaited<ReturnType<typeof startTestServer>>
