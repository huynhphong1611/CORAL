/**
 * Deterministic runner shared by coral-agent and `coral run` (SPEC §8, D09).
 * No AI here: this package must never depend on @coral/brain or an LLM SDK (SPEC P1, D08).
 */
export const RUNNER_PACKAGE = '@coral/runner'

export type { DeviceDriver, Point, Size, TargetLifecycle, UiDriver } from './core/driver'
export { realClock, AbortError, type Clock } from './core/clock'
export { StepFailure, TargetCoveredError } from './core/errors'
export { resolve, findAll, type Resolution, type ResolveContext } from './core/locator/resolve'
export { checkHit, topNodeAt } from './core/hit-test'
export { waitForStable, structureHash } from './core/stability'
export { checkExpect, expectFailure } from './core/expect'
export { createInterpolator, missingSecrets, referencedSecrets } from './core/interpolate'
export { perform } from './core/actions'
export {
  nullSink,
  type ArtifactSink,
  type ItemResult,
  type StepFiles,
  type StepResult,
} from './core/artifacts'
export {
  MAX_POPUPS_PER_STEP,
  RunSetupError,
  noPopupGuard,
  runTestCase,
  type HandledPopup,
  type PopupGuard,
  type RunEvent,
  type RunOptions,
} from './core/run-testcase'
export { LocalDirSink } from './sinks/local-dir'
