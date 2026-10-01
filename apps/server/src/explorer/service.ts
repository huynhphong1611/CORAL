import {
  BrainOutputError,
  BrainUnavailableError,
  BudgetExceededError,
  MAX_HISTORY,
  type Brain,
  type CallContext,
  type DecideInput,
  type ImageInput,
} from '@coral/brain'
import { directionPath } from '@coral/runner'
import {
  STEP_DEFAULTS,
  api,
  fingerprintContext,
  newId,
  numberRecordedStep,
  protocol,
  referenceSecrets,
  screenFingerprint,
  validatePopupsSource,
  type ActionDecision,
  type AppMap,
  type ElementNode,
  type Step,
} from '@coral/shared'
import type { FastifyBaseLogger } from 'fastify'
import type { AgentGateway } from '../agents/gateway'
import { serializeScreen, type ListedElement, type SerializedScreen } from '../ai/screen'
import type { AiService, ProjectBrain } from '../ai/service'
import type { Db } from '../db/client'
import type { ExplorationScreen } from '../db/schema'
import { activityOf } from '../devices/views'
import type { GitAuthor, ProjectRepoStore } from '../git/project-repo-store'
import { HttpError } from '../http/errors'
import type { AgentCommands, CommandResult } from '../live/agent-commands'
import type { Caller } from '../live/control'
import { agentsRepo } from '../repos/agents'
import { brainCallsRepo } from '../repos/brain-calls'
import { buildsRepo } from '../repos/builds'
import {
  explorationHolder,
  explorationsRepo,
  interruptedExplorations,
  validatingExplorations,
  type ExplorationRow,
} from '../repos/explorations'
import { identityRepo } from '../repos/identity'
import { projectsRepo } from '../repos/projects'
import { runControl, type RunNotifier } from '../repos/run-control'
import { testCasesRepo } from '../repos/test-cases'
import { explorationStepKey, type ExplorationFile } from '../storage/keys'
import type { ArtifactStore } from '../storage/s3'
import { APPMAP_PATH, commitAppMap, freeScreenId, parseAppMap, type SeenScreen } from './appmap'
import { Frontier } from './frontier'
import { checkDecision, type SafetyVerdict } from './safety'
import { actionSummary, contentHash, countTransitions, transitionsOf } from './trace'
import { explorationView, stepView } from './views'

type StopReason = api.StopReason
type AgentAction = protocol.AgentAction
type ObserveResult = protocol.CommandResult<'observe'>
type EventType = 'exploration.updated' | 'exploration.step' | 'exploration.screen'

/** Where exploration progress goes (`exploration.watch` of /ws/ui, T033). */
export interface ExplorationEvents {
  emit<T extends EventType>(tenantId: string, type: T, payload: protocol.UiPayload<T>): void
}

/**
 * The Test writer (US3) plugs in here: it writes test cases while the exploration is `writing`,
 * and returns their validation when there is one to wait for (the exploration is `validating`
 * until it settles).
 */
export type ExplorationWriter = (
  exploration: ExplorationRow,
) => Promise<{ validation?: Promise<void> | undefined }>

export interface ExplorationServiceOptions {
  db: Db
  store: ProjectRepoStore
  artifacts: Pick<ArtifactStore, 'presignPut' | 'presignGet' | 'getBytes'>
  agents: Pick<AgentGateway, 'isOnline' | 'onAgentOffline'>
  commands: Pick<AgentCommands, 'send'>
  ai: Pick<AiService, 'ready' | 'projectBrain' | 'secretValues'>
  /** Explorations running at once per tenant (`CORAL_MAX_EXPLORATIONS`). */
  maxPerTenant: number
  notify?: RunNotifier
  events?: ExplorationEvents
  writer?: ExplorationWriter
  /** The device lease is pushed back this far after every step (default 10 min). */
  leaseTtlMs?: number
  log?: FastifyBaseLogger
}

/** prepare may install a build first. */
const PREPARE_TIMEOUT_MS = 180_000
/** observe and record wait for stable screens, take a screenshot and upload it. */
const OBSERVE_TIMEOUT_MS = 45_000
const RECORD_TIMEOUT_MS = 45_000
const RESTART_TIMEOUT_MS = 60_000
const LEASE_TTL_MS = 10 * 60_000
/** `POST /explorations/:id/stop` answers once the exploration left `running` (FR-025). */
export const STOP_WAIT_MS = 15_000
/** Device commands or AI answers failing this many times in a row end the exploration. */
const MAX_FAILURES_IN_A_ROW = 3
const SECRET_REF = /^\$\{secret:([A-Za-z_][A-Za-z0-9_]*)\}$/
const ACTIVE: ExplorationRow['status'][] = ['queued', 'running', 'writing']

const CONTENT_TYPES: Record<ExplorationFile, string> = {
  'screen.jpg': 'image/jpeg',
  'ai.jpg': 'image/jpeg',
  'tree.json': 'application/json',
  'step.jpg': 'image/jpeg',
  'step.json': 'application/json',
  'element.png': 'image/png',
}

const center = (node: ElementNode) => ({
  x: Math.round(node.bounds.x + node.bounds.w / 2),
  y: Math.round(node.bounds.y + node.bounds.h / 2),
})
const whole = (p: { x: number; y: number }) => ({ x: Math.round(p.x), y: Math.round(p.y) })

/** Ends the loop from inside or outside it: a limit, the user, the device or the AI. */
class Stopped extends Error {
  constructor(readonly reason: StopReason) {
    super(`exploration stopped: ${reason}`)
    this.name = 'Stopped'
  }
}

/** The action done at the previous step, judged once the next screen is seen. */
interface Pending {
  from: string
  key?: string
  back?: boolean
  content: string
  history: DecideInput['history'][number]
}

/** One running exploration, in memory: the frontier and history live only while it runs (R9). */
class Session {
  readonly frontier = new Frontier()
  readonly history: DecideInput['history'] = []
  /** Fields that received made-up text, per screen fingerprint (FR-022a). */
  readonly invented = new Map<string, Set<string>>()
  screens: ExplorationScreen[] = []
  stats: api.ExplorationStats = { ...api.EMPTY_EXPLORATION_STATS }
  lastN = 0
  failures = 0
  refused: string | undefined
  pending: Pending | undefined
  current: protocol.UiPayload<'exploration.updated'>['current']
  stopReason: StopReason | undefined
  startedAt = Date.now()
  /** Rejects with `Stopped` once a stop is asked: AI calls and device commands race it. */
  readonly stopped: Promise<never>
  /** Resolves once the exploration left `running` (app map written, device let go). */
  readonly leftRunning: Promise<void>
  private rejectStop!: (error: Stopped) => void
  private resolveLeft!: () => void

  constructor(
    readonly row: ExplorationRow,
    readonly device: { id: string; agentId: string; udid: string },
    readonly appPackage: string,
  ) {
    this.stopped = new Promise<never>((_, reject) => {
      this.rejectStop = reject
    })
    this.stopped.catch(() => undefined)
    this.leftRunning = new Promise((resolve) => {
      this.resolveLeft = resolve
    })
  }

  requestStop(reason: StopReason): void {
    if (this.stopReason) return
    this.stopReason = reason
    this.rejectStop(new Stopped(reason))
  }

  race<T>(work: Promise<T>): Promise<T> {
    return Promise.race([work, this.stopped])
  }

  left(): void {
    this.resolveLeft()
  }
}

/** What every step of one exploration uses, resolved once when it starts. */
interface Run {
  s: Session
  brain: ProjectBrain
  base: Map<string, AppMap['screens'][number]>
  popupsYaml: string
  neverTap: string[]
  secrets: Record<string, string>
}

interface Acted {
  status: 'done' | 'popup' | 'failed'
  step?: Step
  suggestions?: unknown[]
  warnings?: string[]
  error?: string
}

/**
 * The Explorer (US2, research R9): an exploration holds its device with an `exploration` lease and
 * runs in this process, one step after another — `observe`, name the screen, ask the AI, check the
 * answer (R10), act through the Recorder's `record` (R7) — writing every step to the database so
 * the web follows it live and the app map survives a restart. It stops on its budget, the user,
 * the device or the AI; the app map is committed and the device let go before test cases are
 * written (US3).
 */
export class ExplorationService {
  private readonly sessions = new Map<string, Session>()

  constructor(private readonly options: ExplorationServiceOptions) {
    options.agents.onAgentOffline((agent) => {
      for (const session of this.sessions.values()) {
        if (session.device.agentId === agent.id) session.requestStop('device_offline')
      }
    })
  }

  attachLogger(log: FastifyBaseLogger): void {
    this.options.log = log
  }

  private repo(tenantId: string) {
    return explorationsRepo(this.options.db, tenantId)
  }

  private get leaseTtlMs() {
    return this.options.leaseTtlMs ?? LEASE_TTL_MS
  }

  /** True while the exploration runs in this process. */
  isRunning(id: string): boolean {
    return this.sessions.has(id)
  }

  /**
   * POST /explorations: checks project, app, build and device, AI config and limits, takes the
   * device and starts exploring in the background. 409 `device_offline` | `brains_not_configured`
   * | `daily_limit_reached` | `too_many_explorations` | `device_busy`.
   */
  async start(
    caller: Caller,
    input: api.CreateExploration,
    extra: { kind?: api.ExplorationKind; importItemId?: string } = {},
  ): Promise<api.Exploration> {
    const { db, store } = this.options
    const projects = projectsRepo(db, caller.tenantId, store)
    await projects.get(input.project_id)
    const app = await projects.getApp(input.app_id)
    const build = await buildsRepo(db, caller.tenantId).get(input.build_id)
    if (app.projectId !== input.project_id || build.appId !== app.id) {
      throw new HttpError(400, 'validation_failed', 'the app or build is not of this project')
    }
    const agents = agentsRepo(db, caller.tenantId)
    const device = await agents.getDevice(input.device_id)
    if (device.status === 'offline' || !this.options.agents.isOnline(device.agentId)) {
      throw new HttpError(409, 'device_offline', 'the device is offline')
    }
    const config = await this.options.ai.ready(caller.tenantId)
    const repo = this.repo(caller.tenantId)
    if ((await repo.countActive()) >= this.options.maxPerTenant) {
      throw new HttpError(
        409,
        'too_many_explorations',
        `at most ${this.options.maxPerTenant} explorations run at once`,
      )
    }
    const budget: api.ExplorationBudget = {
      ...api.DEFAULT_EXPLORATION_BUDGET,
      max_cost_usd: config.limits.max_cost_usd_per_exploration,
      ...input.budget,
    }
    const kind = extra.kind ?? (input.goal ? 'prompt' : 'explore')
    const created = await repo.create({
      projectId: input.project_id,
      appId: app.id,
      buildId: build.id,
      deviceId: device.id,
      userId: caller.userId,
      kind,
      goal: input.goal ?? null,
      budget,
      maxTests:
        input.max_tests ?? (input.goal ? api.DEFAULT_MAX_TESTS_WITH_GOAL : api.DEFAULT_MAX_TESTS),
      ...(extra.importItemId ? { importItemId: extra.importItemId } : {}),
      leaseTtlMs: this.leaseTtlMs,
    })
    if (!created) {
      const lease = (await agents.openLeases()).find((l) => l.deviceId === device.id)
      throw new HttpError(409, 'device_busy', 'the device is busy', undefined, {
        activity: activityOf(device, lease),
      })
    }
    this.options.notify?.devicesChanged(caller.tenantId)
    const session = new Session(
      created,
      { id: device.id, agentId: device.agentId, udid: device.udid },
      app.packageOrBundleId,
    )
    this.sessions.set(created.id, session)
    void this.run(session, {
      buildKey: build.artifactKey,
      sha256: build.checksumSha256,
      maxCostUsd: budget.max_cost_usd,
    })
    return explorationView(created)
  }

  /** GET /explorations: newest first, without steps. */
  async list(tenantId: string, query: api.ListExplorationsQuery): Promise<api.Exploration[]> {
    const rows = await this.repo(tenantId).list({
      ...(query.project_id ? { projectId: query.project_id } : {}),
      ...(query.status ? { status: query.status } : {}),
    })
    return rows.map(explorationView)
  }

  /**
   * GET /explorations/:id: the exploration with the screens and transitions it saw (pictures from
   * its trace, presigned), the test cases it wrote and the crashes it met.
   */
  async detail(tenantId: string, id: string): Promise<api.ExplorationDetail> {
    const { db, store } = this.options
    const repo = this.repo(tenantId)
    const row = await repo.get(id)
    const [steps, findings, testCases] = await Promise.all([
      repo.steps(id, { limit: 1000 }),
      repo.findings(id),
      testCasesRepo(db, tenantId, store, projectsRepo(db, tenantId, store)).list(row.projectId, {
        sourceRef: `exploration:${id}`,
      }),
    ])
    const idOf = new Map(row.screens.map((screen) => [screen.fingerprint, screen.id]))
    const transitions = transitionsOf(steps).flatMap((t) => {
      const from = idOf.get(t.from)
      const to = idOf.get(t.to)
      return from && to && from !== to ? [{ from, to, action: t.action }] : []
    })
    return {
      ...explorationView(row),
      appmap: {
        screens: await Promise.all(
          row.screens.map(async (screen) => ({
            id: screen.id,
            name: screen.name,
            fingerprint: screen.fingerprint,
            is_new: screen.is_new,
            screenshot_url: await this.presign(
              explorationStepKey(tenantId, id, screen.first_step, 'screen.jpg'),
            ),
          })),
        ),
        transitions,
      },
      test_cases: testCases.map((tc) => ({
        id: tc.id,
        slug: tc.slug,
        status: tc.status,
        draft_reason: tc.draftReason,
        flags: tc.flags,
        validation: tc.validation,
      })),
      findings: await Promise.all(
        findings.map(async (finding) => ({
          id: finding.id,
          step_n: finding.stepN,
          kind: finding.kind,
          log_excerpt: finding.logExcerpt,
          screenshot_url: finding.artifactPrefix
            ? await this.presign(`${finding.artifactPrefix}screen.jpg`)
            : null,
          created_at: finding.createdAt.toISOString(),
        })),
      ),
      writer_report: row.writerReport,
    }
  }

  /** GET /explorations/:id/steps?after=&limit=: the trace, in order. */
  async steps(
    tenantId: string,
    id: string,
    query: { after: number; limit: number },
  ): Promise<api.ExplorationStepView[]> {
    const repo = this.repo(tenantId)
    const row = await repo.get(id)
    const steps = await repo.steps(id, query)
    return Promise.all(steps.map((step) => stepView(step, row.screens, (key) => this.presign(key))))
  }

  /** POST /explorations/:id/stop: answers once the exploration left `running` (≤ 15 s). */
  async stop(tenantId: string, id: string): Promise<api.Exploration> {
    const repo = this.repo(tenantId)
    const row = await repo.get(id)
    const session = this.sessions.get(id)
    if (session) {
      session.requestStop('user_stopped')
      await Promise.race([
        session.leftRunning,
        new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS).unref()),
      ])
    } else if (!session && ACTIVE.includes(row.status)) {
      await this.interrupt(tenantId, id)
    }
    return explorationView(await repo.get(id))
  }

  /**
   * At server start (research R9, clarify 5): explorations a restart cut off are `interrupted`;
   * the app map is written from the steps they stored and their device let go. No test is written.
   */
  async recoverInterrupted(filter: { tenantId?: string } = {}): Promise<number> {
    let count = 0
    for (const { id, tenantId } of await interruptedExplorations(
      this.options.db,
      filter.tenantId,
    )) {
      if (this.sessions.has(id)) continue
      try {
        if (await this.interrupt(tenantId, id)) count += 1
      } catch (error) {
        this.options.log?.error({ err: error, exploration: id }, 'cannot recover exploration')
      }
    }
    // Validation runs keep going in the dispatcher, but nothing waits for them any more: the
    // exploration ends, its test cases stay `draft` with the runs they got (they can be run).
    for (const { id, tenantId } of await validatingExplorations(this.options.db, filter.tenantId)) {
      const repo = this.repo(tenantId)
      const row = await repo.get(id)
      const final = row.stopReason === 'user_stopped' ? 'stopped' : 'done'
      if (await repo.update(id, { status: final, finishedAt: new Date() }, ['validating'])) {
        count += 1
      }
    }
    return count
  }

  /** Lease sweeper: a running exploration keeps its device; an orphaned one is interrupted. */
  async expire(lease: { holderRef: string; tenantId: string }): Promise<boolean> {
    if (!lease.holderRef.startsWith('exploration:')) return false
    const id = lease.holderRef.slice('exploration:'.length)
    if (this.sessions.has(id)) {
      await this.repo(lease.tenantId).touchLease(id, this.leaseTtlMs)
      return true
    }
    await this.interrupt(lease.tenantId, id).catch((error: unknown) =>
      this.options.log?.error({ err: error, exploration: id }, 'cannot interrupt exploration'),
    )
    await runControl(this.options.db, this.options.notify).releaseLease(lease.holderRef, 'timeout')
    return true
  }

  // --- the loop -----------------------------------------------------------------------------

  private async run(
    s: Session,
    build: { buildKey: string; sha256: string; maxCostUsd: number },
  ): Promise<void> {
    let reason: StopReason = 'error'
    let failed = false
    try {
      reason = await this.explore(s, build)
    } catch (error) {
      if (error instanceof Stopped) {
        reason = error.reason
      } else {
        failed = true
        this.options.log?.error({ err: error, exploration: s.row.id }, 'exploration failed')
      }
    }
    try {
      await this.finish(s, reason, failed)
    } catch (error) {
      this.options.log?.error({ err: error, exploration: s.row.id }, 'cannot finish exploration')
    } finally {
      this.sessions.delete(s.row.id)
      s.left()
    }
  }

  private async explore(
    s: Session,
    build: { buildKey: string; sha256: string; maxCostUsd: number },
  ): Promise<StopReason> {
    const { row } = s
    const repo = this.repo(row.tenantId)
    s.startedAt = Date.now()
    await repo.update(row.id, { status: 'running', startedAt: new Date(s.startedAt) }, ['queued'])
    this.updated(s, 'running')

    const brain = await this.options.ai
      .projectBrain({
        tenantId: row.tenantId,
        projectId: row.projectId,
        ref: { type: 'exploration', id: row.id },
        maxCostUsd: build.maxCostUsd,
      })
      .catch((error: unknown) => {
        // The tenant's config went away between the check and the start.
        if (error instanceof HttpError && error.status === 409) throw new Stopped('ai_unavailable')
        throw error
      })
    const { db, store } = this.options
    const projects = projectsRepo(db, row.tenantId, store)
    const popupsYaml = (
      await testCasesRepo(db, row.tenantId, store, projects).readPopups(row.projectId)
    ).yaml
    const popups = validatePopupsSource(popupsYaml, 'popups.yaml').value
    const base = await this.baseAppMap(row)
    const run: Run = {
      s,
      brain,
      base: new Map(base.screens.map((screen) => [screen.fingerprint, screen])),
      popupsYaml,
      neverTap: [...(popups?.never_tap ?? []), ...brain.loaded.rules.neverTap],
      secrets: this.options.ai.secretValues(),
    }
    await this.prepare(run, build)

    for (;;) {
      const limit = this.limitReached(s)
      // With a goal, the budget ran out before the AI reached it (US5).
      if (limit) return s.row.kind === 'prompt' ? 'goal_not_reached' : limit
      const outcome = await this.step(run)
      if (outcome) return outcome
      if (s.failures >= MAX_FAILURES_IN_A_ROW) {
        throw new Error(`${MAX_FAILURES_IN_A_ROW} steps in a row failed`)
      }
    }
  }

  private limitReached(s: Session): StopReason | undefined {
    if (s.stopReason) throw new Stopped(s.stopReason)
    const { budget } = s.row
    if (s.stats.steps >= budget.max_steps) return 'max_steps'
    if (Date.now() - s.startedAt >= budget.max_minutes * 60_000) return 'max_minutes'
    if (s.stats.cost_usd >= budget.max_cost_usd) return 'budget'
    return undefined
  }

  /** The app installed when its build changed, its data cleared, launched (segment 1). */
  private async prepare(run: Run, build: { buildKey: string; sha256: string }): Promise<void> {
    const { s } = run
    const result = await this.send(
      run,
      {
        kind: 'prepare',
        package: s.appPackage,
        build: {
          download_url: (await this.options.artifacts.presignGet(build.buildKey)).url,
          sha256: build.sha256,
        },
        app_state: 'fresh',
        popups_yaml: run.popupsYaml,
        upload: {
          screen: await this.put(s, 0, 'step.jpg'),
          tree: await this.put(s, 0, 'step.json'),
        },
        redact: Object.values(run.secrets),
      },
      PREPARE_TIMEOUT_MS,
    )
    if (!result.ok) throw new Error(`preparing the app failed: ${result.error?.message ?? ''}`)
  }

  /** One trace step; returns why the exploration ends when it does. */
  private async step(run: Run): Promise<StopReason | undefined> {
    const { s } = run
    const n = s.lastN + 1
    const observed = await this.observe(run, n)
    if (!observed) {
      s.failures += 1
      return undefined
    }
    const { tree } = observed
    const fingerprint = screenFingerprint(
      tree,
      fingerprintContext(s.appPackage, {
        package: observed.package,
        ...(observed.activity ? { activity: observed.activity } : {}),
      }),
    )
    const content = contentHash(tree)
    const inFront = observed.package === s.appPackage
    const pending = s.pending
    if (pending) {
      s.frontier.record({
        from: pending.from,
        to: fingerprint,
        ...(pending.key !== undefined ? { key: pending.key } : {}),
        ...(pending.back ? { back: true } : {}),
        treeChanged: content !== pending.content,
      })
      s.pending = undefined
    }

    if (observed.crash) {
      await this.repo(s.row.tenantId).addFinding({
        explorationId: s.row.id,
        stepN: n,
        kind: observed.crash.kind,
        logExcerpt: observed.crash.log_excerpt,
        artifactPrefix: this.stepPrefix(s, n),
      })
      s.stats = { ...s.stats, findings: s.stats.findings + 1 }
      if (pending) pending.history.outcome = `the app ${observed.crash.kind.replace('_', ' ')}`
      return this.restart(run, n, fingerprint, undefined)
    }

    const serialized = serializeScreen(tree, {
      appPackage: s.appPackage,
      screen: { width: observed.screen_width, height: observed.screen_height },
      neverTap: run.neverTap,
      forbidden: run.brain.loaded.rules.forbidden,
      secrets: run.secrets,
      tried: s.frontier.triedOn(fingerprint),
      dead: s.frontier.deadOn(fingerprint),
      ...(observed.app_running && inFront ? { image: await this.image(s, n) } : {}),
    })
    const screen =
      observed.app_running && inFront
        ? await this.nameScreen(run, n, fingerprint, observed, serialized)
        : undefined
    if (pending) {
      pending.history.outcome = !observed.app_running
        ? 'the app closed'
        : !inFront
          ? `left the app (${observed.package})`
          : pending.from === fingerprint
            ? content === pending.content
              ? 'nothing changed'
              : 'same screen, changed'
            : (screen?.name ?? 'another screen')
    }

    const remedy = s.frontier.stuck({ appRunning: observed.app_running, appInFront: inFront })
    if (remedy === 'restart_app') return this.restart(run, n, fingerprint, screen)
    if (remedy === 'back' || s.frontier.overDepth(s.row.budget.max_depth)) {
      if (remedy === 'back') s.frontier.backedOut()
      return this.systemBack(run, n, fingerprint, screen, content)
    }

    const input = { ...serialized.input, ...(screen ? { knownAs: screen.name } : {}) }
    const budget = s.row.budget
    const decision = await this.ask(run, (brain, ctx) =>
      brain.nextAction(
        {
          screen: input,
          ...(s.row.goal ? { goal: s.row.goal } : {}),
          history: s.history.slice(-MAX_HISTORY),
          budget: {
            stepsLeft: Math.max(0, budget.max_steps - s.stats.steps),
            depth: s.frontier.depth,
            maxDepth: budget.max_depth,
            costUsd: s.stats.cost_usd,
            maxCostUsd: budget.max_cost_usd,
          },
          ...(s.refused ? { refused: s.refused } : {}),
        },
        ctx,
      ),
    )
    const callId = run.brain.lastCallId() ?? null
    if (!decision) {
      s.failures += 1
      await this.store(run, { n, fingerprint, screen, status: 'failed', callId })
      return undefined
    }

    const verdict = checkDecision(decision, {
      screen: serialized,
      tree,
      neverTap: run.neverTap,
      testData: run.brain.loaded.rules.testData,
      secrets: run.secrets,
      allowSubmit: run.brain.loaded.rules.allowSubmit,
      inventedFields: s.invented.get(fingerprint) ?? new Set(),
    })
    const element =
      'element' in decision ? serialized.elements.find((e) => e.n === decision.element) : undefined
    const summary = actionSummary(decision, element?.node)
    const history = { n, screen: screen?.name ?? 'outside the app', action: summary, outcome: '' }
    this.remember(s, history)

    if (!verdict.ok) {
      s.refused = verdict.message
      history.outcome = `refused: ${verdict.message}`
      s.stats = { ...s.stats, refused: s.stats.refused + 1 }
      await this.store(run, {
        n,
        fingerprint,
        screen,
        decision,
        status: 'refused',
        refusal: verdict.refusal,
        callId,
        summary,
      })
      return undefined
    }
    s.refused = undefined

    if (decision.action === 'done') {
      history.outcome = decision.goal_reached ? 'goal reached' : 'goal not reachable'
      await this.store(run, { n, fingerprint, screen, decision, status: 'done', callId, summary })
      return decision.goal_reached ? 'goal_reached' : 'goal_not_reached'
    }
    if (decision.action === 'restart_app') {
      return this.restart(run, n, fingerprint, screen, decision, callId)
    }

    const acted = await this.act(run, n, decision, verdict)
    s.failures = acted.status === 'failed' ? s.failures + 1 : 0
    if (acted.status === 'failed') history.outcome = `failed: ${acted.error ?? 'error'}`
    if (
      decision.action === 'type' &&
      acted.status === 'done' &&
      verdict.flags.includes('invented_text') &&
      verdict.element
    ) {
      const fields = s.invented.get(fingerprint) ?? new Set<string>()
      fields.add(verdict.element.key)
      s.invented.set(fingerprint, fields)
    }
    const flags = new Set<api.StepFlag>(verdict.flags)
    if (acted.warnings?.includes('never_tap')) flags.add('never_tap')
    await this.store(run, {
      n,
      fingerprint,
      screen,
      decision,
      status: acted.status,
      ...(acted.step ? { step: acted.step } : {}),
      ...(acted.suggestions ? { suggestions: acted.suggestions } : {}),
      flags: [...flags],
      callId,
      summary,
    })
    if (acted.status !== 'failed') {
      s.pending = {
        from: fingerprint,
        ...(verdict.element ? { key: verdict.element.key } : {}),
        ...(decision.action === 'back' ? { back: true } : {}),
        content,
        history,
      }
    }
    return undefined
  }

  /** The system goes back on its own: stuck, out of the app, or deeper than `max_depth`. */
  private async systemBack(
    run: Run,
    n: number,
    fingerprint: string,
    screen: ExplorationScreen | undefined,
    content: string,
  ): Promise<undefined> {
    const { s } = run
    const summary = actionSummary(null, undefined, 'back')
    const history = { n, screen: screen?.name ?? 'outside the app', action: summary, outcome: '' }
    this.remember(s, history)
    const acted = await this.record(run, n, { kind: 'back' })
    s.failures = acted.status === 'failed' ? s.failures + 1 : 0
    await this.store(run, {
      n,
      fingerprint,
      screen,
      status: acted.status,
      ...(acted.step ? { step: acted.step } : {}),
      ...(acted.suggestions ? { suggestions: acted.suggestions } : {}),
      summary,
    })
    if (acted.status !== 'failed') s.pending = { from: fingerprint, back: true, content, history }
    return undefined
  }

  /** `restart_app`: a crash, the app gone, still stuck after Back, or the AI's choice. */
  private async restart(
    run: Run,
    n: number,
    fingerprint: string,
    screen: ExplorationScreen | undefined,
    decision?: ActionDecision,
    callId?: string | null,
  ): Promise<undefined> {
    const { s } = run
    const result = await this.send(
      run,
      { kind: 'restart_app', package: s.appPackage },
      RESTART_TIMEOUT_MS,
    )
    const summary = actionSummary(decision ?? null, undefined, 'restart_app')
    const history = {
      n,
      screen: screen?.name ?? 'outside the app',
      action: summary,
      outcome: result.ok ? 'the app opened again' : `failed: ${result.error?.message ?? 'error'}`,
    }
    this.remember(s, history)
    if (result.ok) {
      s.frontier.restarted()
      s.invented.clear()
      s.pending = undefined
      s.failures = 0
    } else {
      s.failures += 1
    }
    await this.store(run, {
      n,
      fingerprint,
      screen,
      ...(decision ? { decision } : {}),
      status: result.ok ? 'restart' : 'failed',
      callId: callId ?? null,
      summary,
    })
    return undefined
  }

  /** What the AI asked for, through the Recorder (research R7). */
  private async act(
    run: Run,
    n: number,
    decision: Exclude<ActionDecision, { action: 'done' | 'restart_app' }>,
    verdict: Extract<SafetyVerdict, { ok: true }>,
  ): Promise<Acted> {
    const element = verdict.element
    switch (decision.action) {
      case 'tap':
      case 'long_press': {
        if (!element) return { status: 'failed', error: 'no element' }
        return this.record(run, n, { kind: decision.action, ...center(element.node) })
      }
      case 'tap_point':
        if (!verdict.point) return { status: 'failed', error: 'no point' }
        return this.record(run, n, { kind: 'tap', ...whole(verdict.point) })
      case 'swipe': {
        if (!element) return { status: 'failed', error: 'no element' }
        const [from, to] = directionPath(
          element.node.bounds,
          decision.direction,
          STEP_DEFAULTS.swipeDistancePct,
        )
        return this.record(run, n, { kind: 'swipe', from: whole(from), to: whole(to) })
      }
      case 'type':
        if (!element) return { status: 'failed', error: 'no element' }
        return this.type(run, n, decision, element)
      case 'back':
        return this.record(run, n, { kind: 'back' })
      case 'hide_keyboard':
        return this.record(run, n, { kind: 'hide_keyboard' })
    }
  }

  /**
   * `type #n`: a plain tap at the field's centre gives it the focus, then `record(type)` types and
   * records one `type` step on the focused field — with the field's locators from the list when
   * the device reports no focus (research R7).
   */
  private async type(
    run: Run,
    n: number,
    decision: Extract<ActionDecision, { action: 'type' }>,
    element: ListedElement,
  ): Promise<Acted> {
    const value = this.typedValue(run, decision)
    if (!value) return { status: 'failed', error: 'the value to type is not known on this server' }
    const focus = await this.send(run, { kind: 'tap', ...center(element.node) })
    if (!focus.ok) return { status: 'failed', error: focus.error?.message ?? 'tap failed' }
    const acted = await this.record(run, n, {
      kind: 'type',
      text: value.text,
      redact: value.secret !== undefined ? [value.text] : [],
      ...(value.secret !== undefined ? { secret: value.secret } : {}),
    })
    if (acted.step?.action === 'type' && !acted.step.target && element.locators.length > 0) {
      acted.step = { ...acted.step, target: element.locators }
    }
    return acted
  }

  /** The text to type: a secret's value, named test data, or the AI's own (checked) text. */
  private typedValue(
    run: Run,
    decision: Extract<ActionDecision, { action: 'type' }>,
  ): { text: string; secret?: string } | undefined {
    const fromSecret = (name: string) => {
      const text = run.secrets[name]
      return text ? { text, secret: name } : undefined
    }
    if (decision.secret !== undefined) return fromSecret(decision.secret)
    if (decision.test_data !== undefined) {
      const data = run.brain.loaded.rules.testData[decision.test_data]
      if (data === undefined) return undefined
      const secret = SECRET_REF.exec(data)?.[1]
      return secret !== undefined ? fromSecret(secret) : data ? { text: data } : undefined
    }
    return decision.text ? { text: decision.text } : undefined
  }

  // --- device ---------------------------------------------------------------------------------

  private async send(
    run: Run,
    command: protocol.AgentCommand,
    timeoutMs?: number,
  ): Promise<CommandResult> {
    const { s } = run
    const result = await s.race(
      this.options.commands.send(
        s.device.agentId,
        { commandId: newId(), udid: s.device.udid, command },
        timeoutMs,
      ),
    )
    if (!result.ok && result.error?.code === 'device_offline') throw new Stopped('device_offline')
    return result
  }

  private async observe(run: Run, n: number): Promise<ObserveResult | undefined> {
    const { s } = run
    const result = await this.send(
      run,
      {
        kind: 'observe',
        package: s.appPackage,
        popups_yaml: run.popupsYaml,
        upload: {
          screen: await this.put(s, n, 'screen.jpg'),
          ai: await this.put(s, n, 'ai.jpg'),
          tree: await this.put(s, n, 'tree.json'),
        },
        redact: Object.values(run.secrets),
      },
      OBSERVE_TIMEOUT_MS,
    )
    const parsed = result.ok
      ? protocol.commandResultSchemas.observe.safeParse(result.result)
      : undefined
    if (!parsed?.success) {
      this.options.log?.warn(
        { exploration: s.row.id, n, error: result.error },
        'observe failed on the device',
      )
      return undefined
    }
    return parsed.data
  }

  private async record(run: Run, n: number, action: AgentAction): Promise<Acted> {
    const { s } = run
    const result = await this.send(
      run,
      {
        kind: 'record',
        action,
        package: s.appPackage,
        popups_yaml: run.popupsYaml,
        upload: {
          screen: await this.put(s, n, 'step.jpg'),
          tree: await this.put(s, n, 'step.json'),
          element: await this.put(s, n, 'element.png'),
        },
        redact: Object.values(run.secrets),
      },
      RECORD_TIMEOUT_MS,
    )
    if (!result.ok) return { status: 'failed', error: result.error?.message ?? 'record failed' }
    const parsed = protocol.commandResultSchemas.record.safeParse(result.result)
    if (!parsed.success) return { status: 'failed', error: 'the agent sent an invalid result' }
    const data = parsed.data
    if (data.popup_rule) return { status: 'popup', warnings: data.warnings }
    if (!data.step) return { status: 'failed', error: 'nothing was recorded' }
    // What the agent read on the screen never carries a secret value (FR-013).
    return {
      status: 'done',
      step: referenceSecrets(numberRecordedStep(data.step, n), run.secrets),
      suggestions: referenceSecrets(data.suggestions, run.secrets),
      warnings: data.warnings,
    }
  }

  // --- screens, AI, records -------------------------------------------------------------------

  /** The app map before this exploration; a broken file counts as empty (it is never overwritten). */
  private async baseAppMap(row: ExplorationRow): Promise<AppMap> {
    const text = await this.options.store.readFile(row.tenantId, row.projectId, APPMAP_PATH, 'HEAD')
    try {
      return parseAppMap(text)
    } catch (error) {
      this.options.log?.warn({ err: error, project: row.projectId }, 'app map is not valid')
      return parseAppMap(null)
    }
  }

  /**
   * The screen's id and name: from this exploration, else from the app map, else named by the AI
   * (`describeScreen`) with a free id. Stored at once so the app map survives a restart.
   */
  private async nameScreen(
    run: Run,
    n: number,
    fingerprint: string,
    observed: ObserveResult,
    serialized: SerializedScreen,
  ): Promise<ExplorationScreen> {
    const { s } = run
    const seen = s.screens.find((screen) => screen.fingerprint === fingerprint)
    if (seen) return seen
    const known = run.base.get(fingerprint)
    let id: string
    let name: string
    if (known) {
      ;({ id, name } = known)
    } else {
      const summary = await this.ask(run, (brain, ctx) =>
        brain.describeScreen(serialized.input, ctx),
      )
      name = summary?.name ?? `Screen ${s.screens.length + 1}`
      const taken = new Set([...run.base.values(), ...s.screens].map((screen) => screen.id))
      id = freeScreenId(taken, name)
    }
    const screen: ExplorationScreen = {
      fingerprint,
      id,
      name,
      package: observed.package,
      ...(observed.activity ? { activity: observed.activity } : {}),
      first_step: n,
      is_new: !known,
      first_seen_at: new Date().toISOString(),
    }
    s.screens = [...s.screens, screen]
    s.stats = {
      ...s.stats,
      screens: s.screens.length,
      new_screens: s.screens.filter((x) => x.is_new).length,
    }
    await this.repo(s.row.tenantId).update(s.row.id, { screens: s.screens, stats: s.stats })
    this.emit(s, 'exploration.screen', {
      exploration_id: s.row.id,
      screen: { id, name, fingerprint, is_new: screen.is_new },
    })
    return screen
  }

  /** The downscaled screenshot `observe` uploaded, for providers with vision. */
  private async image(s: Session, n: number): Promise<ImageInput | undefined> {
    const key = this.key(s, n, 'ai.jpg')
    const bytes = await this.options.artifacts.getBytes(key)
    if (!bytes) return undefined
    return { mediaType: 'image/jpeg', data: Buffer.from(bytes).toString('base64'), ref: key }
  }

  /**
   * One AI call, raced with a stop. Budget and availability end the exploration; an answer that
   * stays invalid after the re-asks is a failed step.
   */
  private async ask<T>(
    run: Run,
    call: (brain: Brain, ctx: CallContext) => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await run.s.race(call(run.brain.brain, run.brain.context('explorer')))
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        throw new Stopped(error.scope === 'daily' ? 'daily_limit' : 'budget')
      }
      if (error instanceof BrainUnavailableError) throw new Stopped('ai_unavailable')
      if (error instanceof BrainOutputError) {
        this.options.log?.warn({ exploration: run.s.row.id, err: error }, 'AI answer not valid')
        return undefined
      }
      throw error
    }
  }

  private remember(s: Session, entry: DecideInput['history'][number]): void {
    s.history.push(entry)
    if (s.history.length > MAX_HISTORY) s.history.shift()
  }

  /** Writes trace step `n`, updates the totals and tells the watchers. */
  private async store(
    run: Run,
    input: {
      n: number
      fingerprint: string
      screen: ExplorationScreen | undefined
      decision?: ActionDecision
      status: api.ExplorationStepStatus
      refusal?: api.StepRefusal
      step?: Step
      suggestions?: unknown[]
      flags?: api.StepFlag[]
      callId?: string | null
      summary?: string
    },
  ): Promise<void> {
    const { s } = run
    const repo = this.repo(s.row.tenantId)
    const cost = await this.costOf(s)
    const row = await repo.addStep(s.row.id, {
      n: input.n,
      segment: s.frontier.segment,
      fingerprint: input.fingerprint,
      screenId: input.screen?.id ?? null,
      decision: input.decision ?? null,
      status: input.status,
      refusal: input.refusal ?? null,
      step: input.step ?? null,
      suggestions: input.suggestions ?? [],
      flags: input.flags ?? [],
      artifactPrefix: this.stepPrefix(s, input.n),
      brainCallId: input.callId ?? null,
      costUsd: Math.max(0, cost - s.stats.cost_usd),
    })
    s.lastN = input.n
    s.stats = { ...s.stats, steps: s.stats.steps + 1, cost_usd: cost }
    await repo.update(s.row.id, { stats: s.stats })
    await repo.touchLease(s.row.id, this.leaseTtlMs)
    s.current = {
      n: input.n,
      ...(input.screen ? { screen_name: input.screen.name } : {}),
      action_summary: (input.summary ?? input.status).slice(0, 200),
    }
    if (this.options.events) {
      const step = await stepView(row, s.screens, (key) => this.presign(key))
      this.emit(s, 'exploration.step', { exploration_id: s.row.id, step })
    }
    this.updated(s, 'running')
  }

  /** What the AI cost this exploration so far (every attempt, fallbacks included). */
  private costOf(s: Session): Promise<number> {
    return brainCallsRepo(this.options.db, s.row.tenantId).costOf('exploration', s.row.id)
  }

  // --- the end ----------------------------------------------------------------------------------

  /**
   * Leaves `running` (research R9): the app map is committed, the device let go, then the test
   * cases are written (US3) — `stopped` when the user stopped it, `done` otherwise, `failed` after
   * an error the loop could not get past.
   */
  private async finish(s: Session, reason: StopReason, failed: boolean): Promise<void> {
    const { row } = s
    const repo = this.repo(row.tenantId)
    s.stats = { ...s.stats, cost_usd: await this.costOf(s) }
    await this.writeAppMap(row, s.screens)
      .then((written) => {
        s.screens = written.screens
        s.stats = {
          ...s.stats,
          transitions: written.transitions,
          ...(written.full ? { appmap_full: true } : {}),
        }
        return repo.update(row.id, {
          screens: s.screens,
          stats: s.stats,
          ...(written.commit ? { appmapCommit: written.commit } : {}),
        })
      })
      .catch((error: unknown) =>
        this.options.log?.error({ err: error, exploration: row.id }, 'cannot write the app map'),
      )
    await runControl(this.options.db, this.options.notify).releaseLease(
      explorationHolder(row.id),
      reason === 'device_offline'
        ? 'agent_offline'
        : reason === 'user_stopped'
          ? 'cancelled'
          : 'done',
    )
    const final = failed ? 'failed' : reason === 'user_stopped' ? 'stopped' : 'done'
    // A goal not reached leads to no test case (US5): the trace and the AI's reason are the report.
    const writes = !failed && (row.kind !== 'prompt' || reason === 'goal_reached')
    const writer = writes ? this.options.writer : undefined
    await repo.update(
      row.id,
      {
        status: writer ? 'writing' : final,
        stopReason: reason,
        stats: s.stats,
        ...(writer ? {} : { finishedAt: new Date() }),
      },
      ['queued', 'running'],
    )
    s.current = undefined
    this.updated(s, writer ? 'writing' : final, reason)
    s.left()
    if (!writer) return
    let validation: Promise<void> | undefined
    try {
      ;({ validation } = await writer(await repo.get(row.id)))
    } catch (error) {
      this.options.log?.error({ err: error, exploration: row.id }, 'writing test cases failed')
    }
    s.stats = (await repo.get(row.id)).stats
    if (!validation) {
      await repo.update(row.id, { status: final, finishedAt: new Date() }, ['writing'])
      this.updated(s, final, reason)
      return
    }
    // The validation runs go through the dispatcher; the exploration ends when they all did.
    await repo.update(row.id, { status: 'validating' }, ['writing'])
    this.updated(s, 'validating', reason)
    void validation
      .catch((error: unknown) =>
        this.options.log?.error({ err: error, exploration: row.id }, 'validation failed'),
      )
      .then(async () => {
        s.stats = (await repo.get(row.id)).stats
        await repo.update(row.id, { status: final, finishedAt: new Date() }, ['validating'])
        this.updated(s, final, reason)
      })
      .catch((error: unknown) =>
        this.options.log?.error({ err: error, exploration: row.id }, 'cannot end exploration'),
      )
  }

  /** Marks a cut-off exploration `interrupted` and writes its app map from what it stored. */
  private async interrupt(tenantId: string, id: string): Promise<boolean> {
    const repo = this.repo(tenantId)
    const row = await repo.get(id)
    const claimed = await repo.update(
      id,
      { status: 'interrupted', stopReason: 'interrupted', finishedAt: new Date() },
      ACTIVE,
    )
    if (!claimed) return false
    const written = await this.writeAppMap(row, row.screens).catch((error: unknown) => {
      this.options.log?.error({ err: error, exploration: id }, 'cannot write the app map')
      return undefined
    })
    const stats = {
      ...row.stats,
      ...(written ? { transitions: written.transitions } : {}),
      ...(written?.full ? { appmap_full: true } : {}),
    }
    await repo.update(id, {
      stats,
      ...(written ? { screens: written.screens } : {}),
      ...(written?.commit ? { appmapCommit: written.commit } : {}),
    })
    await runControl(this.options.db, this.options.notify).releaseLease(
      explorationHolder(id),
      'cancelled',
    )
    this.options.events?.emit(tenantId, 'exploration.updated', {
      exploration_id: id,
      status: 'interrupted',
      stop_reason: 'interrupted',
      stats,
    })
    return true
  }

  /**
   * One commit of `appmap/screens.json` with the pictures of new screens (from the trace) and
   * the transitions the stored steps show. A screen whose fingerprint another exploration named
   * first takes that id, and so do its steps.
   */
  private async writeAppMap(
    row: ExplorationRow,
    screens: readonly ExplorationScreen[],
  ): Promise<{
    screens: ExplorationScreen[]
    transitions: number
    full: boolean
    commit: string | null
  }> {
    const repo = this.repo(row.tenantId)
    const steps = await repo.steps(row.id, { limit: 1000 })
    const transitions = transitionsOf(steps)
    const seen: SeenScreen[] = await Promise.all(
      screens.map(async (screen) => {
        const snapshot = screen.is_new ? await this.snapshotOf(row, screen.first_step) : undefined
        return {
          fingerprint: screen.fingerprint,
          id: screen.id,
          name: screen.name,
          package: screen.package,
          ...(screen.activity ? { activity: screen.activity } : {}),
          firstSeenAt: new Date(screen.first_seen_at),
          ...(snapshot ? { snapshot } : {}),
        }
      }),
    )
    const result = await commitAppMap(this.options.store, {
      tenantId: row.tenantId,
      projectId: row.projectId,
      explorationId: row.id,
      screens: seen,
      transitions,
      author: await this.authorOf(row),
    })
    const renamed: ExplorationScreen[] = []
    for (const screen of screens) {
      const id = result.ids.get(screen.fingerprint)
      if (id && id !== screen.id) {
        await repo.setStepScreen(row.id, screen.fingerprint, id)
        renamed.push({ ...screen, id })
      } else {
        renamed.push(screen)
      }
    }
    return {
      screens: renamed,
      transitions: countTransitions(transitions),
      full: result.full,
      commit: result.commit,
    }
  }

  private async snapshotOf(
    row: ExplorationRow,
    n: number,
  ): Promise<SeenScreen['snapshot'] | undefined> {
    const [screen, tree] = await Promise.all([
      this.options.artifacts.getBytes(explorationStepKey(row.tenantId, row.id, n, 'screen.jpg')),
      this.options.artifacts.getBytes(explorationStepKey(row.tenantId, row.id, n, 'tree.json')),
    ])
    return screen && tree ? { screen, tree } : undefined
  }

  /** App map commits are authored by the person who started the exploration. */
  private async authorOf(row: ExplorationRow): Promise<GitAuthor> {
    const found = await identityRepo(this.options.db).findUserWithTenantById(
      row.userId,
      row.tenantId,
    )
    return found
      ? { name: found.user.name, email: found.user.email }
      : { name: row.userName, email: 'coral@localhost' }
  }

  // --- helpers ------------------------------------------------------------------------------------

  private key(s: Session, n: number, file: ExplorationFile): string {
    return explorationStepKey(s.row.tenantId, s.row.id, n, file)
  }

  private stepPrefix(s: Session, n: number): string {
    const key = this.key(s, n, 'screen.jpg')
    return key.slice(0, key.lastIndexOf('/') + 1)
  }

  /** A presigned PUT for one trace file, tagged for the 30-day retention (data-model §5). */
  private async put(s: Session, n: number, file: ExplorationFile): Promise<string> {
    return (
      await this.options.artifacts.presignPut(this.key(s, n, file), CONTENT_TYPES[file], {
        runArtifact: true,
      })
    ).url
  }

  private async presign(key: string): Promise<string> {
    return (await this.options.artifacts.presignGet(key)).url
  }

  private emit<T extends EventType>(s: Session, type: T, payload: protocol.UiPayload<T>): void {
    this.options.events?.emit(s.row.tenantId, type, payload)
  }

  private updated(s: Session, status: api.ExplorationStatus, reason?: StopReason): void {
    this.emit(s, 'exploration.updated', {
      exploration_id: s.row.id,
      status,
      ...(reason ? { stop_reason: reason } : {}),
      stats: s.stats,
      ...(s.current ? { current: s.current } : {}),
    })
  }
}
