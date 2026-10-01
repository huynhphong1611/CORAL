import {
  BrainOutputError,
  BrainUnavailableError,
  BudgetExceededError,
  type TraceStepInput,
} from '@coral/brain'
import {
  elementTreeSchema,
  referenceSecrets,
  type api,
  validateTestCaseSource,
  walkTree,
  type ElementNode,
  type ExpectCondition,
  type Step,
} from '@coral/shared'
import type { FastifyBaseLogger } from 'fastify'
import type { AiService } from '../ai/service'
import type { ExplorationWriter } from '../explorer/service'
import type { Db } from '../db/client'
import type { ProjectRepoStore } from '../git/project-repo-store'
import { explorationsRepo, type ExplorationRow } from '../repos/explorations'
import { identityRepo } from '../repos/identity'
import { projectsRepo } from '../repos/projects'
import { testCasesRepo, type TestCaseRow } from '../repos/test-cases'
import { explorationStepKey, type ExplorationFile } from '../storage/keys'
import type { ArtifactStore } from '../storage/s3'
import { assemble, AssembleError, freeSlug, signatureOf, type WriterRow } from './assemble'
import type { ValidationService } from './validation'

/** New text listed for a step (the writer sees what appeared). */
const MAX_NEW_TEXTS = 10
const SOURCES = { explore: 'ai_explore', prompt: 'ai_prompt', import: 'ai_import' } as const

export interface WriterServiceOptions {
  db: Db
  store: ProjectRepoStore
  artifacts: Pick<ArtifactStore, 'getBytes'>
  ai: Pick<AiService, 'projectBrain' | 'secretValues'>
  log?: FastifyBaseLogger
}

/** What one writing produced: the test cases saved, in order, and what it reports (D48). */
export interface Written {
  testCases: TestCaseRow[]
  report: api.WriterReport
}

/** Why the writer gave no plan, as the report says it. */
function writerError(error: unknown): api.WriterReport['error'] | undefined {
  if (error instanceof BudgetExceededError) return 'budget'
  if (error instanceof BrainUnavailableError) return 'ai_unavailable'
  if (error instanceof BrainOutputError) return 'invalid_output'
  return undefined
}

const quote = (text: string) => JSON.stringify(text)

/** `tap "Log In"`, `type secret TEST_USER into "id/nameET"`: a recorded step in a few words. */
export function stepSummary(step: Step | null, decision: unknown): string {
  if (!step) {
    const d = decision as { action?: string; element?: number } | null
    return d?.action ? `${d.action.replace('_', ' ')}${d.element ? ` #${d.element}` : ''}` : '—'
  }
  const target = 'target' in step ? step.target : undefined
  const first = target?.find((l) => l.text ?? l.desc ?? l.android_id)
  const label = first ? quote(first.text ?? first.desc ?? first.android_id ?? '') : ''
  switch (step.action) {
    case 'tap':
    case 'long_press':
      return `${step.action.replace('_', ' ')}${label ? ` ${label}` : ' a point'}`
    case 'type': {
      const secret = /^\$\{secret:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(step.value)?.[1]
      return `type ${secret ? `secret ${secret}` : quote(step.value)}${label ? ` into ${label}` : ''}`
    }
    case 'swipe':
      return 'swipe'
    default:
      return step.action.replace('_', ' ')
  }
}

/** A Recorder suggestion as the writer reads it: `visible_text "Log In"`, `visible {…}`. */
export function describeExpect(condition: ExpectCondition): string {
  if (condition.visible_text !== undefined) return `visible_text ${quote(condition.visible_text)}`
  if (condition.visible !== undefined) return `visible ${JSON.stringify(condition.visible)}`
  if (condition.not_visible !== undefined) {
    return `not_visible ${JSON.stringify(condition.not_visible)}`
  }
  if (condition.screen !== undefined) return `screen ${condition.screen}`
  return JSON.stringify(condition)
}

/** Text a person reads in the app's windows (status bar and keyboard left out). */
function appTexts(tree: readonly ElementNode[] | undefined, appPackage: string): string[] {
  if (!tree) return []
  const windows = tree.filter((w) => w.package_or_bundle === appPackage)
  return [...walkTree(windows)].filter((n) => n.visible && n.text.trim()).map((n) => n.text.trim())
}

/**
 * The Test writer (US3, research R12): once an exploration left `running`, the AI picks at most
 * `max_tests` flows from its trace (`writeTest`, counted in the exploration's budget) and each
 * flow becomes a test case — assembled without AI, one commit each with the snapshots copied
 * from the trace, `draft` until validated. Duplicates of the project's test cases are left out.
 */
export class WriterService {
  constructor(private readonly options: WriterServiceOptions) {}

  attachLogger(log: FastifyBaseLogger): void {
    this.options.log = log
  }

  async write(exploration: ExplorationRow): Promise<Written> {
    const { db, store } = this.options
    const { tenantId, projectId } = exploration
    const repo = explorationsRepo(db, tenantId)
    const rows = await repo.steps(exploration.id, { limit: 1000 })
    const written: Written = { testCases: [], report: { flows: 0, skipped: [], error: null } }
    if (rows.length === 0) return written
    const app = await projectsRepo(db, tenantId, store).getApp(exploration.appId)
    const appPackage = app.packageOrBundleId
    const secrets = this.options.ai.secretValues()

    const trees = new Map<number, ElementNode[] | undefined>()
    for (const row of rows) trees.set(row.n, await this.tree(exploration, row.n))
    const writerRows: WriterRow[] = rows.map((row) => ({
      n: row.n,
      segment: row.segment,
      fingerprint: row.fingerprint,
      status: row.status,
      step: (row.step as Step | null) ?? null,
      suggestions: (row.suggestions as ExpectCondition[] | null) ?? [],
      flags: row.flags,
    }))
    const steps = this.traceInput(exploration, writerRows, trees, appPackage, secrets, rows)

    const brain = await this.options.ai.projectBrain({
      tenantId,
      projectId,
      ref: { type: 'exploration', id: exploration.id },
      maxCostUsd: exploration.budget.max_cost_usd,
    })
    let plan
    try {
      plan = await brain.brain.writeTest(
        {
          kind: exploration.kind,
          ...(exploration.goal ? { goal: exploration.goal } : {}),
          maxTests: exploration.maxTests,
          steps,
        },
        brain.context('writer'),
      )
    } catch (error) {
      const code = writerError(error)
      if (!code) throw error
      this.options.log?.warn(
        { err: error, exploration: exploration.id },
        'no test case written: the writer gave no plan',
      )
      written.report.error = code
      await repo.update(exploration.id, { writerReport: written.report })
      return written
    }

    const projects = projectsRepo(db, tenantId, store)
    const testCases = testCasesRepo(db, tenantId, store, projects)
    const existing = await testCases.list(projectId)
    const taken = new Set(existing.map((t) => t.slug))
    // Steps of every test case the project has → its slug: a flow with the same steps is left out.
    const signatures = new Map<string, string>()
    for (const row of existing) {
      const parsed = validateTestCaseSource(await testCases.readYaml(row), row.pathInRepo)
      if (parsed.value) signatures.set(signatureOf(parsed.value.steps), row.slug)
    }
    const author = await this.authorOf(exploration)
    const elements = new Map<number, boolean>()
    for (const row of writerRows) {
      const target = row.step && 'target' in row.step ? row.step.target : undefined
      if (target?.some((l) => l.image !== undefined)) {
        elements.set(row.n, Boolean(await this.bytes(exploration, row.n, 'element.png')))
      }
    }

    const flows = plan.flows.slice(0, exploration.maxTests)
    written.report.flows = flows.length
    const skip = (
      flow: (typeof flows)[number],
      reason: api.WriterReport['skipped'][number]['reason'],
      extra: { duplicate_of?: string; message?: string },
    ) =>
      written.report.skipped.push({
        slug: flow.slug,
        name: flow.name,
        intent: flow.intent,
        reason,
        ...extra,
      })
    for (const flow of flows) {
      const slug = freeSlug(taken, flow.slug)
      let made
      try {
        made = assemble({
          flow,
          slug,
          rows: writerRows,
          tree: (n) => trees.get(n),
          hasElement: (n) => elements.get(n) ?? false,
          appPackage,
          secrets,
        })
      } catch (error) {
        if (!(error instanceof AssembleError)) throw error
        this.options.log?.warn(
          { exploration: exploration.id, flow: flow.slug, issues: error.issues },
          `flow left out: ${error.message}`,
        )
        const [issue] = error.issues
        skip(flow, error.code, {
          message: issue ? `${issue.path}: ${issue.message}` : error.message,
        })
        continue
      }
      const same = signatures.get(made.signature)
      if (same !== undefined) {
        skip(flow, 'duplicate', { duplicate_of: same })
        continue
      }
      const snapshots: Record<string, Uint8Array> = {}
      for (const source of made.snapshots) {
        const bytes = await this.bytes(exploration, source.n, source.file)
        if (bytes) snapshots[source.path] = bytes
      }
      const saved = await testCases.saveGenerated(projectId, {
        testCase: made.testCase,
        yaml: made.yaml,
        snapshots,
        author,
        userId: exploration.userId,
        source: SOURCES[exploration.kind],
        sourceRef: `exploration:${exploration.id}`,
        flags: made.flags,
        draftReason: made.draftReason,
      })
      taken.add(slug)
      signatures.set(made.signature, slug)
      written.testCases.push(saved)
      const current = await repo.get(exploration.id)
      await repo.update(exploration.id, {
        stats: { ...current.stats, tests_written: current.stats.tests_written + 1 },
      })
    }
    await repo.update(exploration.id, { writerReport: written.report })
    return written
  }

  /** The trace as the writer reads it: steps, screens before and after, new text, candidates. */
  private traceInput(
    exploration: ExplorationRow,
    rows: readonly WriterRow[],
    trees: ReadonlyMap<number, ElementNode[] | undefined>,
    appPackage: string,
    secrets: Readonly<Record<string, string>>,
    source: readonly { n: number; decision: unknown }[],
  ): TraceStepInput[] {
    const nameOf = (fingerprint: string) =>
      exploration.screens.find((s) => s.fingerprint === fingerprint)?.name ?? 'outside the app'
    const seen = new Map<number, Set<string>>()
    return rows.map((row, i) => {
      const next = rows[i + 1]
      const after = next && next.segment === row.segment ? next : undefined
      const visited = seen.get(row.segment) ?? new Set<string>()
      visited.add(row.fingerprint)
      seen.set(row.segment, visited)
      const afterFingerprint = after?.fingerprint ?? row.fingerprint
      const before = new Set(appTexts(trees.get(row.n), appPackage))
      const textsAfter = after
        ? [...new Set(appTexts(trees.get(after.n), appPackage))]
            .filter((t) => !before.has(t))
            .slice(0, MAX_NEW_TEXTS)
        : []
      const decision = source.find((s) => s.n === row.n)?.decision ?? null
      return referenceSecrets(
        {
          n: row.n,
          segment: row.segment,
          screen: nameOf(row.fingerprint),
          after: nameOf(afterFingerprint),
          newScreen: row.status === 'done' && !visited.has(afterFingerprint),
          action: stepSummary(row.step, decision),
          status: row.status,
          textsAfter,
          candidates: row.suggestions.map(describeExpect),
          flags: row.flags,
        },
        secrets,
      )
    })
  }

  private async bytes(
    exploration: ExplorationRow,
    n: number,
    file: ExplorationFile,
  ): Promise<Uint8Array | undefined> {
    return this.options.artifacts.getBytes(
      explorationStepKey(exploration.tenantId, exploration.id, n, file),
    )
  }

  /** What `observe` saw before step `n`, when it can still be read (30 days). */
  private async tree(exploration: ExplorationRow, n: number): Promise<ElementNode[] | undefined> {
    const bytes = await this.bytes(exploration, n, 'tree.json')
    if (!bytes) return undefined
    try {
      const parsed = elementTreeSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)))
      return parsed.success ? parsed.data : undefined
    } catch {
      return undefined
    }
  }

  private async authorOf(row: ExplorationRow) {
    const found = await identityRepo(this.options.db).findUserWithTenantById(
      row.userId,
      row.tenantId,
    )
    return found
      ? { name: found.user.name, email: found.user.email }
      : { name: row.userName, email: 'coral@localhost' }
  }
}

/**
 * The writer hook of the Explorer: write the test cases, then validate them in the background —
 * the exploration stays `validating` until the last run ended, then `stats.tests_active` counts
 * the test cases that became `active`.
 */
export function writeAndValidate(
  writer: Pick<WriterService, 'write'>,
  validation: Pick<ValidationService, 'validate'> | undefined,
  db: Db,
): ExplorationWriter {
  return async (exploration) => {
    const written = await writer.write(exploration)
    const ids = written.testCases.map((t) => t.id)
    if (!validation || ids.length === 0) return {}
    return {
      validation: validation
        .validate({
          tenantId: exploration.tenantId,
          projectId: exploration.projectId,
          buildId: exploration.buildId,
          deviceId: exploration.deviceId,
          userId: exploration.userId,
          testCaseIds: ids,
        })
        .then(async (active) => {
          const repo = explorationsRepo(db, exploration.tenantId)
          const current = await repo.get(exploration.id)
          await repo.update(exploration.id, { stats: { ...current.stats, tests_active: active } })
        }),
    }
  }
}
