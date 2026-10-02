import { z } from 'zod'

/** Object keys (data-model §4). Every key starts with the tenant id (P5). */
export const ARTIFACT_FILES = ['screenshot.png', 'tree.json', 'device.log'] as const
export type ArtifactFile = (typeof ARTIFACT_FILES)[number]

const uuid = z.uuid()
// Step ids come from test cases; keep keys to a safe character set.
const stepIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'invalid step id')

function tenantPrefix(tenantId: string): string {
  return `${uuid.parse(tenantId)}/`
}

export function buildKey(tenantId: string, buildId: string): string {
  return `${tenantPrefix(tenantId)}builds/${uuid.parse(buildId)}.apk`
}

/** A reference image of an `image` locator, stored by content (research R12). */
export function assetKey(tenantId: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('invalid sha256')
  return `${tenantPrefix(tenantId)}assets/${sha256}`
}

export function runItemPrefix(tenantId: string, runId: string, runItemId: string): string {
  return `${tenantPrefix(tenantId)}runs/${uuid.parse(runId)}/${uuid.parse(runItemId)}/`
}

/** Directory of one step's artifacts; stored as `run_steps.artifact_prefix`. */
export function stepPrefix(
  tenantId: string,
  runId: string,
  runItemId: string,
  stepIndex: number,
  stepId: string,
): string {
  const index = z.number().int().nonnegative().parse(stepIndex)
  return `${runItemPrefix(tenantId, runId, runItemId)}${index}-${stepIdSchema.parse(stepId)}/`
}

export function stepArtifactKey(prefix: string, file: ArtifactFile): string {
  return `${prefix}${file}`
}

export function runItemResultKey(tenantId: string, runId: string, runItemId: string): string {
  return `${runItemPrefix(tenantId, runId, runItemId)}result.json`
}

export const RECORDING_FILES = ['screen.jpg', 'tree.json', 'element.png'] as const
export type RecordingFile = (typeof RECORDING_FILES)[number]

/** Everything a recording uploaded (data-model §5); removed with the recording. */
export function recordingPrefix(tenantId: string, recordingId: string): string {
  return `${tenantPrefix(tenantId)}recordings/${uuid.parse(recordingId)}/`
}

/** One file of step `n`'s snapshot. */
export function recordingStepKey(
  tenantId: string,
  recordingId: string,
  n: number,
  file: RecordingFile,
): string {
  const step = z.number().int().positive().parse(n)
  return `${recordingPrefix(tenantId, recordingId)}${step}/${file}`
}

/**
 * Files of trace step `n` (data-model §5): `screen.jpg`, `ai.jpg` and `tree.json` are what
 * `observe` saw before it; `step.jpg`, `step.json` and `element.png` are the snapshot `record` took
 * right before acting — the step's snapshot in a test case. Step 0 holds what `prepare` saw.
 */
export const EXPLORATION_FILES = [
  'screen.jpg',
  'ai.jpg',
  'tree.json',
  'step.jpg',
  'step.json',
  'element.png',
] as const
export type ExplorationFile = (typeof EXPLORATION_FILES)[number]

/** The trace of an exploration (data-model §5), kept 30 days by the retention tag. */
export function explorationPrefix(tenantId: string, explorationId: string): string {
  return `${tenantPrefix(tenantId)}explorations/${uuid.parse(explorationId)}/`
}

/** One file of trace step `n` (0: `prepare`). */
export function explorationStepKey(
  tenantId: string,
  explorationId: string,
  n: number,
  file: ExplorationFile,
): string {
  const step = z.number().int().nonnegative().parse(n)
  return `${explorationPrefix(tenantId, explorationId)}${step}/${file}`
}

/** True when `key` belongs to `tenantId`; check before presigning any key that came from outside. */
export function keyBelongsTo(key: string, tenantId: string): boolean {
  return key.startsWith(tenantPrefix(tenantId)) && !key.includes('..')
}

const IMPORT_EXTENSIONS = { csv: 'csv', xlsx: 'xlsx', gherkin: 'feature' } as const

/** The file a person uploaded to import (data-model §5); removed once the job ends. */
export function importSourceKey(
  tenantId: string,
  jobId: string,
  format: keyof typeof IMPORT_EXTENSIONS,
): string {
  return `${tenantPrefix(tenantId)}imports/${uuid.parse(jobId)}/source.${IMPORT_EXTENSIONS[format]}`
}
