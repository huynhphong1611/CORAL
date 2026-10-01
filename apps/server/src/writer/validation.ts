import { FAILURE_CODES, type api } from '@coral/shared'
import type { FastifyBaseLogger } from 'fastify'
import type { Db } from '../db/client'
import type { ProjectRepoStore } from '../git/project-repo-store'
import { createRepos } from '../repos'
import { createRun, type RunQueue } from '../runs/create'
import type { SecretSource } from '../runs/secrets'

/** Runs that have not ended yet. */
const UNFINISHED: readonly string[] = ['queued', 'running']
/** Longest wait for one validation run (it may queue behind others on the device). */
const RUN_WAIT_MS = 40 * 60_000

export interface ValidationServiceOptions {
  db: Db
  store: ProjectRepoStore
  secrets: SecretSource
  queue: RunQueue
  /** How often a validation run is looked at while it runs (default 500 ms). */
  pollMs?: number
  log?: FastifyBaseLogger
}

type ValidationRun = api.TestCaseValidation['runs'][number]

/**
 * Validates the test cases the writer made (US3, research R13): two runs in a row
 * (`trigger = validation`, `validation_of`) on the exploration's device and build, through the
 * Phase 1 dispatcher — the deterministic replay itself, no AI. Both passed → `active`; one failed
 * → `draft` with `validation_failed` and the failing step; edited in the meantime → `draft` with
 * `changed_during_validation`. Test cases flagged for review or needing a person stay `draft`
 * without running.
 */
export class ValidationService {
  private readonly repos

  constructor(private readonly options: ValidationServiceOptions) {
    this.repos = createRepos({ db: options.db, store: options.store })
  }

  attachLogger(log: FastifyBaseLogger): void {
    this.options.log = log
  }

  /** Validates one test case after the other; returns how many became `active`. */
  async validate(input: {
    tenantId: string
    projectId: string
    buildId: string
    deviceId: string
    userId: string
    testCaseIds: readonly string[]
  }): Promise<number> {
    let active = 0
    for (const id of input.testCaseIds) {
      try {
        if (await this.validateOne(input, id)) active += 1
      } catch (error) {
        this.options.log?.error({ err: error, testCase: id }, 'validation failed to run')
        await this.repos
          .tenant(input.tenantId)
          .testCases.setStatus(id, { status: 'draft', draftReason: 'validation_failed' })
          .catch(() => undefined)
      }
    }
    return active
  }

  private async validateOne(
    input: {
      tenantId: string
      projectId: string
      buildId: string
      deviceId: string
      userId: string
    },
    id: string,
  ): Promise<boolean> {
    const tenant = this.repos.tenant(input.tenantId)
    const row = await tenant.testCases.get(id)
    if (row.flags.length > 0 || row.draftReason !== null) return false
    const commit = row.headCommit
    const runs: ValidationRun[] = []
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const result = await this.runOnce({ ...input, tenant }, id)
      runs.push(result)
      await tenant.testCases.setStatus(id, { status: 'draft', validation: { commit, runs } })
      if (result.status !== 'passed') break
    }
    const current = await tenant.testCases.get(id)
    const passed = runs.length === 2 && runs.every((r) => r.status === 'passed')
    if (current.headCommit !== commit) {
      await tenant.testCases.setStatus(id, {
        status: 'draft',
        draftReason: 'changed_during_validation',
        validation: { commit, runs },
      })
      return false
    }
    await tenant.testCases.setStatus(id, {
      status: passed ? 'active' : 'draft',
      ...(passed ? { validatedAt: new Date() } : { draftReason: 'validation_failed' }),
      validation: { commit, runs },
    })
    return passed
  }

  /** One validation run of one test case, waited for. */
  private async runOnce(
    input: {
      projectId: string
      buildId: string
      deviceId: string
      userId: string
      tenant: ReturnType<ReturnType<typeof createRepos>['tenant']>
    },
    id: string,
  ): Promise<ValidationRun> {
    const { run } = await createRun(
      { ...input.tenant, auth: { userId: input.userId } },
      {
        project_id: input.projectId,
        build_id: input.buildId,
        device_id: input.deviceId,
        test_case_ids: [id],
      },
      { secrets: this.options.secrets, queue: this.options.queue },
      { trigger: 'validation', validationOf: id },
    )
    const deadline = Date.now() + RUN_WAIT_MS
    let current = run
    while (UNFINISHED.includes(current.status)) {
      if (Date.now() > deadline) {
        return { run_id: run.id, status: current.status }
      }
      await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 500))
      current = await input.tenant.runs.get(run.id)
    }
    const [first] = await input.tenant.runs.items(run.id)
    const code = FAILURE_CODES.find((c) => c === first?.item.failureCode)
    return {
      run_id: run.id,
      status: current.status,
      ...(code ? { failure_code: code } : {}),
      ...(first?.item.failedStepId ? { step_id: first.item.failedStepId } : {}),
    }
  }
}
