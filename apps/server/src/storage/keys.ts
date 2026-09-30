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

/** True when `key` belongs to `tenantId`; check before presigning any key that came from outside. */
export function keyBelongsTo(key: string, tenantId: string): boolean {
  return key.startsWith(tenantPrefix(tenantId)) && !key.includes('..')
}
