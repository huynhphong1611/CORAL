import { stepSchema, type api } from '@coral/shared'
import type { ExplorationScreen } from '../db/schema'
import type { ExplorationRow, ExplorationStepRow } from '../repos/explorations'

const iso = (date: Date) => date.toISOString()
const isoOrNull = (date: Date | null) => (date ? date.toISOString() : null)

/** `Exploration` of the REST API and the web (contracts/rest-api-phase3.md). */
export function explorationView(row: ExplorationRow): api.Exploration {
  return {
    id: row.id,
    project_id: row.projectId,
    app_id: row.appId,
    build_id: row.buildId,
    device_id: row.deviceId,
    kind: row.kind,
    goal: row.goal,
    budget: row.budget,
    max_tests: row.maxTests,
    status: row.status,
    stop_reason: row.stopReason,
    stats: row.stats,
    created_by: { id: row.userId, name: row.userName },
    created_at: iso(row.createdAt),
    started_at: isoOrNull(row.startedAt),
    finished_at: isoOrNull(row.finishedAt),
  }
}

/** The screen of a step by its fingerprint: named once the exploration gave it an id. */
export function screenOf(
  screens: readonly ExplorationScreen[],
  row: Pick<ExplorationStepRow, 'fingerprint' | 'screenId'>,
): api.ExplorationStepView['screen'] {
  const named = screens.find((s) => s.fingerprint === row.fingerprint)
  return {
    id: row.screenId ?? named?.id ?? null,
    name: named?.name ?? null,
    fingerprint: row.fingerprint,
  }
}

/** One trace step (`GET /explorations/:id/steps`, `exploration.step`). */
export async function stepView(
  row: ExplorationStepRow,
  screens: readonly ExplorationScreen[],
  presign: (key: string) => Promise<string>,
): Promise<api.ExplorationStepView> {
  const step = row.step === null ? null : stepSchema.safeParse(row.step)
  return {
    n: row.n,
    segment: row.segment,
    screen: screenOf(screens, row),
    decision: row.decision as api.ExplorationStepView['decision'],
    status: row.status,
    refusal: row.refusal,
    step: step?.success ? step.data : null,
    flags: row.flags,
    brain_call_id: row.brainCallId,
    screenshot_url: row.artifactPrefix ? await presign(`${row.artifactPrefix}screen.jpg`) : null,
    cost_usd: row.costUsd,
    created_at: iso(row.createdAt),
  }
}
