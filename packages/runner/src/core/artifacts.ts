import type { ElementNode, FailureCode, protocol } from '@coral/shared'

export type StepResult = protocol.StepResult

export interface StepFiles {
  /** PNG bytes. */
  screenshot?: Uint8Array
  /** Already redacted by the core. */
  tree?: ElementNode[]
  /** Device log, only when the step failed; already redacted. */
  log?: string
}

export interface StepRef {
  index: number
  id: string
}

/** Where each file went (a path or an object key), echoed in `StepResult.artifacts`. */
export type StepArtifactRefs = StepResult['artifacts']

export interface ItemResult {
  test_case: string
  status: 'passed' | 'failed' | 'error'
  failure_code?: FailureCode
  message?: string
  started_at: string
  duration_ms: number
  steps: StepResult[]
}

/**
 * Destination of a run's evidence (SPEC §8.6): a local folder for `coral run`, presigned S3
 * uploads for the agent. The core redacts secrets before calling it.
 */
export interface ArtifactSink {
  saveStep(testCase: string, step: StepRef, files: StepFiles): Promise<StepArtifactRefs>
  saveResult(result: ItemResult): Promise<void>
}

/** Sink that keeps nothing (tests that do not look at artifacts). */
export const nullSink: ArtifactSink = {
  saveStep: () => Promise.resolve({}),
  saveResult: () => Promise.resolve(),
}
