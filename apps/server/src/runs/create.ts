import { referencedSecrets, validateTestCaseSource, type api } from '@coral/shared'
import { HttpError, notFound, unprocessable } from '../http/errors'
import type { TenantRepos } from '../repos'
import type { RunItemRow, RunRow } from '../repos/runs'
import type { SecretSource } from './secrets'

/** Where a new run goes to wait for its device (BullMQ `run-dispatch`, research R9). */
export interface RunQueue {
  enqueue(runId: string): Promise<void>
}

export interface CreateRunDeps {
  secrets: SecretSource
  queue: RunQueue
}

/**
 * POST /runs (contracts/rest-api.md): every check that does not need the device happens here,
 * so a run that is queued can only fail on the device side.
 */
export async function createRun(
  s: TenantRepos & { auth: { userId: string } },
  input: api.CreateRun,
  deps: CreateRunDeps,
): Promise<{ run: RunRow; items: RunItemRow[] }> {
  await s.projects.get(input.project_id)

  const build = await s.builds.get(input.build_id)
  const app = await s.projects.getApp(build.appId)
  if (app.projectId !== input.project_id) {
    throw unprocessable('build_not_in_project', 'the build belongs to an app of another project')
  }

  const device = await s.agents.getDevice(input.device_id)
  if (device.platform !== 'android') {
    throw unprocessable('device_not_android', 'Phase 1 runs on Android devices only')
  }

  const ids = [...new Set(input.test_case_ids)]
  if (ids.length !== input.test_case_ids.length) {
    throw new HttpError(400, 'validation_failed', 'test_case_ids contains duplicates')
  }
  const rows = await s.testCases.getMany(ids)
  const byId = new Map(rows.map((row) => [row.id, row]))
  const ordered = input.test_case_ids.map((id) => {
    const row = byId.get(id)
    if (!row) throw notFound('test case')
    return row
  })
  const foreign = ordered.filter((row) => row.projectId !== input.project_id)
  if (foreign.length > 0) {
    throw unprocessable(
      'testcase_not_in_project',
      'test cases must belong to the run project',
      foreign.map((row) => ({
        path: 'test_case_ids',
        code: 'testcase_not_in_project',
        message: row.slug,
      })),
    )
  }
  const notAndroid = ordered.filter((row) => !row.platforms.includes('android'))
  if (notAndroid.length > 0) {
    throw unprocessable(
      'platform_mismatch',
      'test cases must list android in platforms',
      notAndroid.map((row) => ({
        path: 'test_case_ids',
        code: 'platform_mismatch',
        message: row.slug,
      })),
    )
  }

  // Secrets referenced at the committed version must exist now (FR-012).
  const needed = new Set<string>()
  for (const row of ordered) {
    const parsed = validateTestCaseSource(await s.testCases.readYaml(row), row.pathInRepo)
    if (parsed.value) for (const name of referencedSecrets(parsed.value)) needed.add(name)
  }
  const available = deps.secrets.get([...needed])
  const missing = [...needed].filter((name) => available[name] === undefined).sort()
  if (missing.length > 0) {
    throw unprocessable(
      'missing_secrets',
      `missing secrets: ${missing.join(', ')}`,
      missing.map((name) => ({ path: 'secrets', code: 'missing_secret', message: name })),
    )
  }

  const popups = await s.projects.projectFile(input.project_id, 'popups')
  const created = await s.runs.create({
    projectId: input.project_id,
    buildId: build.id,
    deviceId: device.id,
    popupsCommit: popups.headCommit,
    createdBy: s.auth.userId,
    items: ordered.map((row) => ({ testCaseId: row.id, commit: row.headCommit })),
  })
  await s.audit({ actor: `user:${s.auth.userId}`, action: 'run.create', target: created.run.id })
  await deps.queue.enqueue(created.run.id)
  return created
}
