import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FakeScript } from '@coral/brain'
import { api, newId, type LogLevel } from '@coral/shared'
import { eq } from 'drizzle-orm'
import { AgentGateway } from '../agents/gateway'
import { BrainsSettings } from '../ai/brains-config'
import { AiService } from '../ai/service'
import {
  ExplorationService,
  type ExplorationEvents,
  type ExplorationServiceOptions,
} from '../explorer/service'
import { createRepos } from '../repos'
import { ValidationService } from '../writer/validation'
import { WriterService, writeAndValidate } from '../writer/service'
import { DEV_JWT_SECRET, loadConfig } from '../config'
import { leases } from '../db/schema'
import { RunDispatcher } from '../runs/dispatcher'
import { registerIngest, startLeaseSweeper } from '../runs/ingest'
import { envSecrets } from '../runs/secrets'
import { UiGateway } from '../ui/gateway'
import { RunEvents } from '../ui/run-events'
import { ExplorationWatchers } from '../ui/exploration-events'
import { ImportWatchers } from '../ui/import-events'
import { ImportService } from '../imports/service'
import { AgentCommands } from '../live/agent-commands'
import { LiveControl } from '../live/control'
import { RecordingService } from '../recordings/service'
import { deviceLookup, StreamHub } from '../live/stream-hub'
import { multipart } from './multipart'
import { startTestServer, type TestUser } from './test-server'

export interface RunServerOptions {
  heartbeatMs?: number
  ackTimeoutMs?: number
  queueTimeoutMs?: number
  runTimeoutMs?: number
  retryMinMs?: number
  retryMaxMs?: number
  /** Idle time after which a live control session ends (default 10 min). */
  liveIdleMs?: number
  /** Secret values the server knows (as CORAL_SECRET_<NAME>). */
  secrets?: Record<string, string>
  /** Server log (default silent), wired to the gateway, dispatcher, ingest and sweeper as in main. */
  logging?: { level?: LogLevel; stream?: { write(line: string): void } }
  /** The Explorer with the `fake` brains (examples/brains.fake.yaml as the platform default). */
  explorer?: Partial<Pick<ExplorationServiceOptions, 'maxPerTenant' | 'leaseTtlMs'>> & {
    /** false: no platform default, so a tenant without brains.yaml gets `brains_not_configured`. */
    platformBrains?: boolean
    /** false: no Test writer after an exploration (US2 tests). */
    write?: boolean
    /** false: test cases are written but not validated. */
    validate?: boolean
    /** Tool calls the `fake` brains make (US7). */
    fakeScript?: FakeScript
  }
}

const FAKE_BRAINS = fileURLToPath(new URL('../../../../examples/brains.fake.yaml', import.meta.url))

/** Exploration events as the service emitted them, for assertions. */
export type EmittedEvent = { tenantId: string; type: string; payload: unknown }

export const LOGIN_YAML = `schema: coral/testcase@1
id: login
intent: 'Đăng nhập'
platforms: [android]
variables:
  user: \${secret:TEST_USER}
steps:
  - id: s1
    action: launch
    expect: { visible_text: 'Login' }
  - id: s2
    action: type
    target: [{ android_id: 'id/user' }]
    value: \${var:user}
  - id: s3
    action: tap
    target: [{ text: 'Login' }]
    expect: { visible_text: 'Products' }
`

/**
 * Integration server with the whole run pipeline: gateway, BullMQ dispatcher (own Redis prefix),
 * ingest and lease sweeper — plus a helper that creates project, app, build, test case and agent.
 */
export async function startRunServer(options: RunServerOptions = {}) {
  const config = loadConfig(process.env)
  const secretEnv = Object.fromEntries(
    Object.entries(options.secrets ?? { TEST_USER: 'bob@example.com' }).map(([k, v]) => [
      `CORAL_SECRET_${k}`,
      v,
    ]),
  )
  let gateway: AgentGateway | undefined
  let dispatcher: RunDispatcher | undefined
  // Both sockets, as in production: agent tests also check they do not disturb each other.
  let uiGateway: UiGateway | undefined
  let events: RunEvents | undefined
  let streams: StreamHub | undefined
  let live: LiveControl | undefined
  let recordings: RecordingService | undefined
  let explorations: ExplorationService | undefined
  let imports: ImportService | undefined
  let brains: BrainsSettings | undefined
  const emitted: EmittedEvent[] = []
  const server = await startTestServer(({ db, store, artifacts }) => {
    gateway = new AgentGateway({ db, heartbeatMs: options.heartbeatMs ?? 15_000 })
    uiGateway = new UiGateway({ jwtSecret: DEV_JWT_SECRET })
    const notify = new RunEvents({ db, ui: uiGateway })
    events = notify
    gateway.onDevicesChanged((tenantId) => notify.devicesChanged(tenantId))
    streams = new StreamHub({
      ui: uiGateway,
      agents: gateway,
      findDevice: deviceLookup(db, gateway),
    })
    const secrets = envSecrets(secretEnv)
    dispatcher = new RunDispatcher({
      db,
      gateway,
      artifacts,
      store,
      secrets,
      redisUrl: config.redisUrl,
      prefix: `coral-test-${newId()}`,
      queueTimeoutMs: options.queueTimeoutMs ?? 600_000,
      runTimeoutMs: options.runTimeoutMs ?? 1_800_000,
      ackTimeoutMs: options.ackTimeoutMs ?? 30_000,
      retryMinMs: options.retryMinMs ?? 50,
      retryMaxMs: options.retryMaxMs ?? 200,
      notify,
    })
    registerIngest({ db, gateway, dispatcher, artifacts, notify })
    const commands = new AgentCommands(gateway)
    live = new LiveControl({
      db,
      ui: uiGateway,
      agents: gateway,
      commands,
      secrets,
      idleMs: options.liveIdleMs ?? 600_000,
      notify,
    })
    recordings = new RecordingService({
      db,
      store,
      artifacts,
      ui: uiGateway,
      agents: gateway,
      commands,
      live,
      secrets,
      idleMs: options.liveIdleMs ?? 600_000,
      notify,
    })
    if (options.explorer) {
      const aiConfig: typeof config.ai = {
        ...config.ai,
        fakeBrains: true,
        brainsDefaultPath: FAKE_BRAINS,
      }
      if (options.explorer.platformBrains === false) delete aiConfig.brainsDefaultPath
      const settings = new BrainsSettings({ ai: aiConfig, secrets })
      brains = settings
      const watchers = new ExplorationWatchers({ db, ui: uiGateway })
      const events: ExplorationEvents = {
        emit: (tenantId, type, payload) => {
          emitted.push({ tenantId, type, payload })
          watchers.emit(tenantId, type, payload)
        },
      }
      const ai = new AiService({
        repos: createRepos({ db, store }),
        store,
        artifacts,
        settings,
        secrets,
        fakeBrains: true,
        stdioAllowlist: [],
        ...(options.explorer.fakeScript ? { fakeScript: options.explorer.fakeScript } : {}),
      })
      const writer =
        options.explorer.write === false
          ? undefined
          : writeAndValidate(
              new WriterService({ db, store, artifacts, ai }),
              options.explorer.validate === false
                ? undefined
                : new ValidationService({ db, store, secrets, queue: dispatcher, pollMs: 100 }),
              db,
            )
      explorations = new ExplorationService({
        db,
        store,
        artifacts,
        agents: gateway,
        commands,
        ai,
        maxPerTenant: options.explorer.maxPerTenant ?? 5,
        notify,
        events,
        ...(writer ? { writer } : {}),
        ...(options.explorer.leaseTtlMs ? { leaseTtlMs: options.explorer.leaseTtlMs } : {}),
      })
      imports = new ImportService({
        db,
        store,
        artifacts,
        agents: gateway,
        ai,
        explorations,
        events: new ImportWatchers({ db, ui: uiGateway }),
        pollMs: 100,
        retryMs: 300,
      })
    }
    return {
      gateway,
      uiGateway,
      runs: { dispatcher, secrets },
      live,
      recordings,
      ...(explorations ? { explorations } : {}),
      ...(imports ? { imports } : {}),
      ...(brains ? { brains } : {}),
    }
  }, options.logging)
  if (!gateway || !dispatcher) throw new Error('run server not wired')
  dispatcher.attachLogger(server.app.log)
  explorations?.attachLogger(server.app.log)
  events?.attachLogger(server.app.log)
  const url = await server.listen()
  const sweeper = startLeaseSweeper({
    db: server.db,
    dispatcher,
    notify: events,
    expire: async (lease) =>
      ((await live?.expire(lease)) ?? false) ||
      ((await recordings?.expire(lease)) ?? false) ||
      ((await explorations?.expire(lease)) ?? false),
    intervalMs: 60_000,
    log: server.app.log,
  })

  /** Project + app + build + one test case (+ an agent token) for `user`. */
  async function seed(user: TestUser, yaml = LOGIN_YAML) {
    const call = server.call
    const project = api.projectSchema.parse(
      (await call(user, { method: 'POST', url: '/projects', payload: { name: `p-${newId()}` } }))
        .body,
    )
    const app = api.appSchema.parse(
      (
        await call(user, {
          method: 'POST',
          url: `/projects/${project.id}/apps`,
          payload: { platform: 'android', package_or_bundle_id: 'com.example.app', name: 'App' },
        })
      ).body,
    )
    const apk = randomBytes(2048)
    const build = api.buildSchema.parse(
      (
        await call(user, {
          method: 'POST',
          url: `/apps/${app.id}/builds`,
          ...multipart({ version: '1.0.0' }, { name: 'app.apk', data: apk }),
        })
      ).body,
    )
    const testCase = api.savedTestCaseSchema.parse(
      (
        await call(user, {
          method: 'POST',
          url: `/projects/${project.id}/testcases`,
          payload: { yaml },
        })
      ).body,
    )
    const agent = await server.newAgent(user, `agent-${newId()}`)
    return { project, app, build, apk, testCase, agent }
  }

  /**
   * The lease of a run once released. A run ends first and its lease is released right after,
   * so a test that saw the run end waits here before looking at the lease or the device.
   */
  async function releasedLease(runId: string, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const [lease] = await server.db
        .select()
        .from(leases)
        .where(eq(leases.holderRef, `run:${runId}`))
      if (lease?.releasedAt) return lease
      if (Date.now() > deadline) throw new Error(`lease of run ${runId} not released`)
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  async function close() {
    imports?.close()
    sweeper.stop()
    events?.stop()
    streams?.stop()
    await dispatcher?.obliterate().catch(() => undefined)
    await dispatcher?.close()
    await server.close()
  }

  return {
    ...server,
    url,
    gateway,
    uiGateway,
    dispatcher,
    sweeper,
    seed,
    releasedLease,
    get streams(): StreamHub {
      if (!streams) throw new Error('run server not wired')
      return streams
    },
    get recordings(): RecordingService {
      if (!recordings) throw new Error('run server not wired')
      return recordings
    },
    get explorations(): ExplorationService {
      if (!explorations) throw new Error('run server started without the explorer')
      return explorations
    },
    get imports(): ImportService {
      if (!imports) throw new Error('run server started without the explorer')
      return imports
    },
    emitted,
    close,
  }
}

export type RunServer = Awaited<ReturnType<typeof startRunServer>>
