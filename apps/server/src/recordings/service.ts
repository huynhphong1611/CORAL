import {
  newId,
  numberRecordedStep,
  protocol,
  recordingToYaml,
  referenceSecrets,
  snapshotPath,
  validateTestCaseSource,
  type api,
  type RecordingStep,
  type ValidationIssue,
} from '@coral/shared'
import type { FastifyBaseLogger } from 'fastify'
import type { AgentGateway, AgentRef } from '../agents/gateway'
import type { Db } from '../db/client'
import { activityOf } from '../devices/views'
import type { GitAuthor, ProjectRepoStore } from '../git/project-repo-store'
import { HttpError } from '../http/errors'
import type { AgentCommands, CommandResult } from '../live/agent-commands'
import { toAgentCommand, type Caller, type LiveControl } from '../live/control'
import { agentsRepo } from '../repos/agents'
import { buildsRepo } from '../repos/builds'
import { liveRepo } from '../repos/live'
import { projectsRepo } from '../repos/projects'
import {
  expiredRecordings,
  recordingHolder,
  recordingsOnAgent,
  recordingsRepo,
  type RecordingRow,
} from '../repos/recordings'
import { runControl, type RunNotifier } from '../repos/run-control'
import { testCasesRepo } from '../repos/test-cases'
import type { SecretSource } from '../runs/secrets'
import {
  keyBelongsTo,
  recordingPrefix,
  recordingStepKey,
  type RecordingFile,
} from '../storage/keys'
import type { ArtifactStore } from '../storage/s3'
import type { UiContext, UiGateway } from '../ui/gateway'

type EndReason = protocol.UiPayload<'live.ended'>['reason']
type LiveCommand = protocol.UiPayload<'live.command'>

const CONTENT_TYPES: Record<RecordingFile, string> = {
  'screen.jpg': 'image/jpeg',
  'tree.json': 'application/json',
  'element.png': 'image/png',
}
/** A record step waits for two stable screens, a screenshot and three uploads. */
const RECORD_TIMEOUT_MS = 45_000
/** prepare may install a build first. */
const PREPARE_TIMEOUT_MS = 180_000

export interface RecordingServiceOptions {
  db: Db
  store: ProjectRepoStore
  artifacts: Pick<ArtifactStore, 'presignPut' | 'presignGet' | 'removePrefix' | 'getBytes'>
  ui: Pick<UiGateway, 'on' | 'broadcastToTenant'>
  agents: Pick<AgentGateway, 'isOnline' | 'onAgentOffline'>
  commands: Pick<AgentCommands, 'send'>
  live: Pick<LiveControl, 'sessionOf' | 'end' | 'useRecordings'>
  secrets: SecretSource
  /** The device is let go after this long without a command (as live control). */
  idleMs: number
  notify?: RunNotifier
  log?: FastifyBaseLogger
}

const failed = (code: string, message: string) => ({ code, message })

/** 400 `validation_failed` with the problems `coral validate` reports (as for test cases). */
function invalidYaml(errors: ValidationIssue[]): HttpError {
  const issues = errors.map(({ file: _file, ...issue }) => issue)
  return new HttpError(400, 'validation_failed', 'YAML is not valid', issues)
}
const iso = (date: Date) => date.toISOString()

/**
 * The Recorder on the server (US4, T041, contracts/rest-api-phase2.md, ui-ws.md): a recording
 * holds its device with a `recording` lease; each `live.command` with `record: true` becomes a
 * `record` command to the agent with presigned PUTs for its snapshot, and the step it returns is
 * numbered, stored and pushed to the recorder's tabs as `recording.step`. Text typed that equals a
 * secret is recorded as `${secret:NAME}` (only the name reaches the browser, FR-014).
 */
export class RecordingService {
  /** One command at a time per recording: a step's number decides its snapshot keys. */
  private readonly queues = new Map<string, Promise<void>>()

  constructor(private readonly options: RecordingServiceOptions) {
    options.live.useRecordings(this)
    options.ui.on('live.inspect', (ctx, message) => this.inspect(ctx, message.payload))
    options.agents.onAgentOffline((agent) => this.agentGone(agent))
  }

  attachLogger(log: FastifyBaseLogger): void {
    this.options.log = log
  }

  private repo(tenantId: string) {
    return recordingsRepo(this.options.db, tenantId)
  }

  /** POST /recordings: takes the device, prepares the app, records `s1 launch`. */
  async start(caller: Caller, input: api.CreateRecording): Promise<api.Recording> {
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
    // Recording on the device one controls takes that control over.
    const session = await this.options.live.sessionOf(caller.tenantId, device.id, caller.userId)
    if (session) await this.options.live.end(session, 'replaced_by_recording')

    const created = await this.repo(caller.tenantId).create({
      projectId: input.project_id,
      appId: app.id,
      buildId: build.id,
      deviceId: device.id,
      userId: caller.userId,
      slug: `recording-${newId().slice(-8)}`,
      leaseTtlMs: this.options.idleMs,
    })
    if (!created) {
      const lease = (await agents.openLeases()).find((l) => l.deviceId === device.id)
      throw new HttpError(409, 'device_busy', 'the device is busy', undefined, {
        activity: activityOf(device, lease),
      })
    }
    this.options.notify?.devicesChanged(caller.tenantId)

    const n = 1
    const keys = this.keys(caller.tenantId, created.id, n)
    const result = await this.options.commands.send(
      device.agentId,
      {
        commandId: newId(),
        udid: device.udid,
        command: {
          kind: 'prepare',
          package: app.packageOrBundleId,
          build: {
            download_url: (await this.options.artifacts.presignGet(build.artifactKey)).url,
            sha256: build.checksumSha256,
          },
          app_state: 'fresh',
          popups_yaml: await this.popupsYaml(caller.tenantId, created.projectId),
          upload: {
            screen: await this.put(keys['screen.jpg']),
            tree: await this.put(keys['tree.json']),
          },
          redact: Object.values(this.secretValues()),
        },
      },
      PREPARE_TIMEOUT_MS,
    )
    const prepared = result.ok
      ? protocol.commandResultSchemas.prepare.safeParse(result.result)
      : undefined
    if (!prepared?.success) {
      await this.close(created, 'discarded', 'released')
      const error = result.error ?? failed('bad_result', 'the agent sent an invalid result')
      throw new HttpError(409, 'prepare_failed', `preparing the app failed: ${error.message}`)
    }
    await this.repo(caller.tenantId).appendStep(created.id, {
      n,
      step: { id: `s${n}`, action: 'launch' },
      suggestions: [],
      warnings: [],
      snapshot: {
        screen: keys['screen.jpg'],
        tree: keys['tree.json'],
        screen_width: prepared.data.screen_width,
        screen_height: prepared.data.screen_height,
      },
      recorded_at: iso(new Date()),
    })
    return this.view(await this.repo(caller.tenantId).get(created.id), true)
  }

  async list(tenantId: string, query: api.ListRecordingsQuery): Promise<api.Recording[]> {
    const rows = await this.repo(tenantId).list({
      ...(query.project_id ? { projectId: query.project_id } : {}),
      ...(query.status ? { status: query.status } : {}),
    })
    return Promise.all(rows.map((row) => this.view(row, false)))
  }

  async get(tenantId: string, id: string): Promise<api.Recording> {
    return this.view(await this.repo(tenantId).get(id), true)
  }

  /** PATCH: steps edited, deleted, reordered, suggestions accepted (FR-016). */
  async patch(caller: Caller, id: string, input: api.PatchRecording): Promise<api.Recording> {
    const row = await this.own(caller, id)
    this.editable(row)
    if (input.steps) {
      const numbers = new Set(input.steps.map((s) => s.n))
      const ids = new Set(input.steps.map((s) => s.step.id))
      if (numbers.size !== input.steps.length || ids.size !== input.steps.length) {
        throw new HttpError(400, 'validation_failed', 'step numbers and ids must be unique')
      }
      const prefix = recordingPrefix(caller.tenantId, id)
      for (const step of input.steps) {
        const { screen, tree, element } = step.snapshot
        for (const key of [screen, tree, ...(element ? [element] : [])]) {
          // A step keeps its own snapshot: never another recording's (or tenant's) objects.
          if (!keyBelongsTo(key, caller.tenantId) || !key.startsWith(prefix)) {
            throw new HttpError(
              400,
              'validation_failed',
              `step ${step.n}: snapshot not of this recording`,
            )
          }
        }
      }
    }
    const updated = await this.repo(caller.tenantId).update(id, {
      ...(input.steps ? { steps: input.steps } : {}),
      ...(input.intent !== undefined ? { intent: input.intent } : {}),
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
    })
    return this.view(updated, true)
  }

  /** POST …/stop: lets the device go; the recording stays editable and savable. */
  async stop(caller: Caller, id: string): Promise<api.Recording> {
    const row = await this.own(caller, id)
    if (row.status === 'recording') await this.close(row, 'stopped', 'released')
    return this.view(await this.repo(caller.tenantId).get(id), false)
  }

  /** POST …/resume: takes the device again (409 when it is busy or offline). */
  async resume(caller: Caller, id: string): Promise<api.Recording> {
    const row = await this.own(caller, id)
    if (row.status !== 'stopped') {
      throw new HttpError(409, 'recording_closed', `the recording is ${row.status}`)
    }
    const agents = agentsRepo(this.options.db, caller.tenantId)
    const device = await agents.getDevice(row.deviceId)
    if (device.status === 'offline' || !this.options.agents.isOnline(device.agentId)) {
      throw new HttpError(409, 'device_offline', 'the device is offline')
    }
    if (!(await this.repo(caller.tenantId).resume(id, this.options.idleMs))) {
      const lease = (await agents.openLeases()).find((l) => l.deviceId === device.id)
      throw new HttpError(409, 'device_busy', 'the device is busy', undefined, {
        activity: activityOf(device, lease),
      })
    }
    this.options.notify?.devicesChanged(caller.tenantId)
    return this.view(await this.repo(caller.tenantId).get(id), false)
  }

  /** GET …/yaml: the test case the steps make, for the preview (not saved). */
  async yaml(tenantId: string, id: string): Promise<api.RecordingYaml> {
    const row = await this.repo(tenantId).get(id)
    const { yaml, validation } = recordingToYaml({
      slug: row.slug,
      intent: row.intent,
      steps: row.steps,
    })
    const issue = ({ file: _file, ...rest }: (typeof validation.errors)[number]) => rest
    return { yaml, warnings: [...validation.errors, ...validation.warnings].map(issue) }
  }

  /**
   * POST …/save (FR-017): validated like `coral validate` — image locators must point at the
   * snapshots being committed — then one commit with the YAML and `snap/<slug>/<step_id>/…`
   * copied from S3; the recording is `saved` and the device let go. 409 `slug_exists` unless
   * `replace` with the current `base_commit`.
   */
  async save(
    caller: Caller & { author: GitAuthor },
    id: string,
    input: api.SaveRecording,
  ): Promise<api.SavedRecording> {
    const row = await this.own(caller, id)
    this.editable(row)
    const { db, store } = this.options
    const projects = projectsRepo(db, caller.tenantId, store)
    const testCases = testCasesRepo(db, caller.tenantId, store, projects)

    // What will be committed: each recorded step's snapshot, under the test case's step id.
    const files = new Map<string, string>()
    for (const step of row.steps) {
      const { screen, tree, element } = step.snapshot
      files.set(snapshotPath(input.slug, step.step.id, 'screen.jpg'), screen)
      files.set(snapshotPath(input.slug, step.step.id, 'tree.json'), tree)
      if (element) files.set(snapshotPath(input.slug, step.step.id, 'element.png'), element)
    }
    const result = validateTestCaseSource(input.yaml, `${input.slug}.yaml`, {
      fileExists: (path) => files.has(path),
    })
    if (!result.valid || !result.value) throw invalidYaml(result.errors)
    const testCase = result.value
    if (testCase.id !== input.slug) {
      throw new HttpError(
        400,
        'validation_failed',
        `id "${testCase.id}" must be the slug "${input.slug}"`,
      )
    }
    const existing = await testCases.bySlug(row.projectId, input.slug)
    if (existing && !input.replace) {
      throw new HttpError(
        409,
        'slug_exists',
        `test case "${input.slug}" already exists`,
        undefined,
        {
          test_case_id: existing.id,
          head_commit: existing.headCommit,
        },
      )
    }

    // Only the steps the test case still has; their snapshot objects, straight from S3.
    const stepIds = new Set(testCase.steps.map((s) => s.id))
    const snapshots: Record<string, Uint8Array> = {}
    await Promise.all(
      [...files].map(async ([path, key]) => {
        if (!stepIds.has(path.split('/')[2] ?? '')) return
        const bytes = await this.options.artifacts.getBytes(key)
        if (bytes) snapshots[path] = bytes
      }),
    )
    const saved = await testCases.saveRecorded(row.projectId, {
      testCase,
      yaml: input.yaml,
      snapshots,
      author: caller.author,
      userId: caller.userId,
      ...(existing && input.replace && input.base_commit
        ? { replace: { id: existing.id, baseCommit: input.base_commit } }
        : {}),
    })
    await this.close(row, 'saved', 'released')
    await this.repo(caller.tenantId).markSaved(row.id, saved.id, input.slug, input.intent)
    // The snapshots live in the project repo now.
    await this.options.artifacts
      .removePrefix(recordingPrefix(caller.tenantId, id))
      .catch((error: unknown) =>
        this.options.log?.warn({ err: error, recording: id }, 'cannot remove saved snapshots'),
      )
    return {
      test_case_id: saved.id,
      head_commit: saved.headCommit,
      warnings: result.warnings.map(({ file: _file, ...issue }) => issue),
    }
  }

  /** DELETE: discarded, device let go, snapshots removed. */
  async discard(caller: Caller, id: string): Promise<void> {
    const row = await this.own(caller, id)
    if (row.status === 'saved') {
      throw new HttpError(409, 'recording_closed', 'a saved recording cannot be discarded')
    }
    await this.close(row, 'discarded', 'released')
    await this.options.artifacts.removePrefix(recordingPrefix(caller.tenantId, id))
  }

  /**
   * The cleanup job (T043, research R10): unsaved recordings untouched for 7 days are `expired`,
   * their device let go and their snapshots removed. Returns how many.
   */
  async expireOld(now = new Date()): Promise<number> {
    let count = 0
    for (const { id, tenantId } of await expiredRecordings(this.options.db, now)) {
      try {
        const row = await this.repo(tenantId).get(id)
        await this.close(row, 'expired', 'idle_timeout')
        await this.options.artifacts.removePrefix(recordingPrefix(tenantId, id))
        count += 1
      } catch (error) {
        this.options.log?.error({ err: error, recording: id }, 'cannot expire recording')
      }
    }
    return count
  }

  /** For the lease sweeper: an expired `recording:` lease stops its recording (idle). */
  async expire(lease: { holderRef: string; tenantId: string }): Promise<boolean> {
    if (!lease.holderRef.startsWith('recording:')) return false
    const row = await this.repo(lease.tenantId)
      .get(lease.holderRef.slice('recording:'.length))
      .catch(() => undefined)
    if (!row) return false
    await this.close(row, 'stopped', 'idle_timeout')
    return true
  }

  // --- browser commands (/ws/ui) --------------------------------------------------------------

  /** `live.command` with `recording_id` (LiveControl hands it over); one at a time per recording. */
  command(ctx: UiContext, payload: LiveCommand): Promise<void> {
    const id = payload.recording_id ?? ''
    const next = (this.queues.get(id) ?? Promise.resolve()).then(() =>
      this.runCommand(ctx, payload).catch((error: unknown) => {
        this.options.log?.error({ err: error, recording: id }, 'recording command failed')
        ctx.fail('internal', 'the command failed')
      }),
    )
    this.queues.set(id, next)
    void next.finally(() => {
      if (this.queues.get(id) === next) this.queues.delete(id)
    })
    return next
  }

  private async runCommand(ctx: UiContext, payload: LiveCommand): Promise<void> {
    const started = Date.now()
    const commandId = newId()
    const answer = (error?: CommandResult['error']) =>
      ctx.reply('live.result', {
        ok: error === undefined,
        ...(error ? { error } : {}),
        command_id: commandId,
        duration_ms: Date.now() - started,
      })
    const { user } = ctx.connection
    const held = await this.held(user, payload.recording_id)
    if ('error' in held) return answer(held.error)
    const { row, device } = held
    const app = await projectsRepo(this.options.db, user.tenantId, this.options.store).getApp(
      row.appId,
    )
    const prepared = await toAgentCommand(payload.command, this.options.secrets, () =>
      Promise.resolve(app.packageOrBundleId),
    )
    if ('error' in prepared) return answer(prepared.error)
    let action = prepared.command
    let secretHint: string | undefined
    if (payload.record && action.kind === 'type' && action.secret === undefined) {
      // Text that equals a secret is recorded as the secret (never its value in a test case).
      const name = this.secretNamed(action.text)
      if (name) {
        secretHint = name
        action = { ...action, secret: name, redact: [action.text] }
      }
    }
    const repo = liveRepo(this.options.db, user.tenantId)
    await repo.recordCommand({
      id: commandId,
      deviceId: row.deviceId,
      recordingId: row.id,
      userId: user.userId,
      kind: payload.record ? 'record' : payload.command.kind,
      params: { ...prepared.params, ...(payload.record ? { action: payload.command.kind } : {}) },
    })
    await this.repo(user.tenantId).touchLease(row.id, this.options.idleMs)

    if (!payload.record) {
      const result = await this.options.commands.send(device.agentId, {
        commandId,
        udid: device.udid,
        command: action,
      })
      await repo.finishCommand(commandId, result.ok ? 'ok' : 'failed', result.error?.code)
      return answer(result.ok ? undefined : result.error)
    }

    const n = await this.repo(user.tenantId).nextStepNumber(row.id)
    const keys = this.keys(user.tenantId, row.id, n)
    const result = await this.options.commands.send(
      device.agentId,
      {
        commandId,
        udid: device.udid,
        command: {
          kind: 'record',
          action,
          package: app.packageOrBundleId,
          popups_yaml: await this.popupsYaml(user.tenantId, row.projectId),
          upload: {
            screen: await this.put(keys['screen.jpg']),
            tree: await this.put(keys['tree.json']),
            element: await this.put(keys['element.png']),
          },
          redact: Object.values(this.secretValues()),
        },
      },
      RECORD_TIMEOUT_MS,
    )
    const parsed = result.ok
      ? protocol.commandResultSchemas.record.safeParse(result.result)
      : undefined
    await repo.finishCommand(commandId, parsed?.success ? 'ok' : 'failed', result.error?.code)
    if (!parsed?.success) {
      return answer(result.error ?? failed('bad_result', 'the agent sent an invalid result'))
    }
    const data = parsed.data
    const toTabs = (message: protocol.UiPayload<'recording.step'>) =>
      this.options.ui.broadcastToTenant(
        user.tenantId,
        'recording.step',
        message,
        (connection) => connection.user.userId === row.userId,
      )
    if (!data.step) {
      toTabs({ recording_id: row.id, popup_rule: data.popup_rule ?? 'popup' })
      return answer()
    }
    // What the agent read on the screen never carries a secret value to the browser or the YAML.
    const secrets = this.secretValues()
    const step = referenceSecrets(numberRecordedStep(data.step, n), secrets)
    const hasImage = 'target' in step && step.target?.some((l) => l.image !== undefined)
    const stored: RecordingStep = {
      n,
      step,
      suggestions: referenceSecrets(data.suggestions, secrets),
      warnings: data.warnings,
      snapshot: {
        screen: keys['screen.jpg'],
        tree: keys['tree.json'],
        ...(hasImage ? { element: keys['element.png'] } : {}),
        screen_width: data.screen_width,
        screen_height: data.screen_height,
      },
      recorded_at: iso(new Date()),
    }
    await this.repo(user.tenantId).appendStep(row.id, stored)
    toTabs({
      recording_id: row.id,
      step: stored,
      ...(secretHint ? { secret_hint: { name: secretHint } } : {}),
    })
    return answer()
  }

  /** `live.inspect` (Assert mode): the element at a point, from a recording or a control session. */
  private async inspect(
    ctx: UiContext,
    payload: protocol.UiPayload<'live.inspect'>,
  ): Promise<void> {
    const { user } = ctx.connection
    if (user.role === 'viewer') return ctx.fail('forbidden', 'viewers cannot inspect devices')
    let deviceId: string
    if (payload.recording_id) {
      const held = await this.held(user, payload.recording_id)
      if ('error' in held) return ctx.fail(held.error.code, held.error.message)
      deviceId = held.row.deviceId
    } else {
      const session = await liveRepo(this.options.db, user.tenantId).get(
        payload.live_session_id ?? '',
      )
      if (!session || session.userId !== user.userId || session.endedAt) {
        return ctx.fail('not_holder', 'you do not control this device')
      }
      deviceId = session.deviceId
    }
    const device = await agentsRepo(this.options.db, user.tenantId).getDevice(deviceId)
    if (!this.options.agents.isOnline(device.agentId)) {
      return ctx.fail('device_offline', 'the device is offline')
    }
    const result = await this.options.commands.send(device.agentId, {
      commandId: newId(),
      udid: device.udid,
      command: {
        kind: 'inspect',
        x: payload.x,
        y: payload.y,
        redact: Object.values(this.secretValues()),
      },
    })
    const parsed = result.ok
      ? protocol.commandResultSchemas.inspect.safeParse(result.result)
      : undefined
    if (!parsed?.success) {
      const error = result.error ?? failed('bad_result', 'the agent sent an invalid result')
      return ctx.fail(error.code, error.message)
    }
    ctx.reply('live.inspected', referenceSecrets(parsed.data, this.secretValues()))
  }

  // --- helpers ------------------------------------------------------------------------------------

  /** The caller's open recording on an online device, or why a command cannot go. */
  private async held(
    user: UiContext['connection']['user'],
    recordingId: string | undefined,
  ): Promise<
    | { row: RecordingRow; device: Awaited<ReturnType<ReturnType<typeof agentsRepo>['getDevice']>> }
    | { error: { code: string; message: string } }
  > {
    const row = await this.repo(user.tenantId)
      .get(recordingId ?? '')
      .catch(() => undefined)
    if (!row || row.userId !== user.userId) {
      return { error: failed('not_holder', 'this is not your recording') }
    }
    if (row.status !== 'recording') {
      return { error: failed('session_ended', `the recording is ${row.status}`) }
    }
    const device = await agentsRepo(this.options.db, user.tenantId).getDevice(row.deviceId)
    if (device.status === 'offline' || !this.options.agents.isOnline(device.agentId)) {
      return { error: failed('device_offline', 'the device is offline') }
    }
    return { row, device }
  }

  /** Every secret of the server, name → value (dev: `CORAL_SECRET_*`, D19). */
  private secretValues(): Record<string, string> {
    return this.options.secrets.get(this.options.secrets.names())
  }

  /** The name of the secret whose value is exactly `text`, if any. */
  private secretNamed(text: string): string | undefined {
    const values = this.secretValues()
    return Object.keys(values).find((name) => values[name] === text)
  }

  private async own(caller: Caller, id: string): Promise<RecordingRow> {
    const row = await this.repo(caller.tenantId).get(id)
    if (row.userId !== caller.userId) {
      throw new HttpError(403, 'forbidden', 'only the person who recorded can change a recording')
    }
    return row
  }

  private editable(row: RecordingRow): void {
    if (row.status !== 'recording' && row.status !== 'stopped') {
      throw new HttpError(409, 'recording_closed', `the recording is ${row.status}`)
    }
  }

  /**
   * Leaves `recording` (stopped, discarded or saved): the lease is released and the recorder's
   * tabs are told when the device was let go for them (idle, agent gone).
   */
  async close(
    row: RecordingRow,
    status: 'stopped' | 'discarded' | 'saved' | 'expired',
    reason: EndReason,
  ): Promise<void> {
    const changed = await this.repo(row.tenantId).setStatus(row.id, status, [
      'recording',
      ...(status === 'stopped' ? [] : (['stopped'] as const)),
    ])
    await runControl(this.options.db, this.options.notify).releaseLease(
      recordingHolder(row.id),
      reason === 'idle_timeout'
        ? 'timeout'
        : reason === 'agent_offline'
          ? 'agent_offline'
          : 'released',
    )
    if (!changed || row.status !== 'recording') return
    this.options.log?.info({ recording: row.id, status, reason }, 'recording let the device go')
    this.options.ui.broadcastToTenant(
      row.tenantId,
      'live.ended',
      { recording_id: row.id, reason },
      (connection) => connection.user.userId === row.userId,
    )
  }

  private async agentGone(agent: AgentRef): Promise<void> {
    for (const { id, tenantId } of await recordingsOnAgent(this.options.db, agent.id)) {
      const row = await this.repo(tenantId).get(id)
      await this.close(row, 'stopped', 'agent_offline')
    }
  }

  private keys(tenantId: string, recordingId: string, n: number) {
    const key = (file: RecordingFile) => recordingStepKey(tenantId, recordingId, n, file)
    return {
      'screen.jpg': key('screen.jpg'),
      'tree.json': key('tree.json'),
      'element.png': key('element.png'),
    }
  }

  private async put(key: string): Promise<string> {
    const file = key.slice(key.lastIndexOf('/') + 1) as RecordingFile
    return (await this.options.artifacts.presignPut(key, CONTENT_TYPES[file])).url
  }

  private async popupsYaml(tenantId: string, projectId: string): Promise<string> {
    const projects = projectsRepo(this.options.db, tenantId, this.options.store)
    const testCases = testCasesRepo(this.options.db, tenantId, this.options.store, projects)
    return (await testCases.readPopups(projectId)).yaml
  }

  private async view(row: RecordingRow, withSteps: boolean): Promise<api.Recording> {
    const url = async (key: string) => (await this.options.artifacts.presignGet(key)).url
    const steps = withSteps
      ? await Promise.all(
          row.steps.map(async (step) => ({
            ...step,
            urls: {
              screen: await url(step.snapshot.screen),
              tree: await url(step.snapshot.tree),
              ...(step.snapshot.element ? { element: await url(step.snapshot.element) } : {}),
            },
          })),
        )
      : undefined
    return {
      id: row.id,
      project_id: row.projectId,
      app_id: row.appId,
      build_id: row.buildId,
      device_id: row.deviceId,
      status: row.status,
      intent: row.intent,
      slug: row.slug,
      ...(steps ? { steps } : {}),
      created_by: { id: row.userId, name: row.userName },
      created_at: iso(row.createdAt),
      updated_at: iso(row.updatedAt),
      expires_at: iso(row.expiresAt),
      test_case_id: row.testCaseId,
    }
  }
}
