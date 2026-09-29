/**
 * Deterministic runner shared by coral-agent and `coral run` (SPEC §8, D09).
 * No AI here: this package must never depend on @coral/brain or an LLM SDK (SPEC P1, D08).
 */
export const RUNNER_PACKAGE = '@coral/runner'

export type {
  DeviceDriver,
  FrameOptions,
  FrameSource,
  LiveFrame,
  Point,
  Size,
  TargetLifecycle,
  UiDriver,
} from './core/driver'
export { imageInfo, type ImageInfo } from './core/image/size'
export { realClock, AbortError, type Clock } from './core/clock'
export { StepFailure, TargetCoveredError } from './core/errors'
export { resolve, findAll, type Resolution, type ResolveContext } from './core/locator/resolve'
export { checkHit, topNodeAt, touchTargetAt } from './core/hit-test'
export { waitForStable, structureHash } from './core/stability'
export { checkExpect, expectFailure } from './core/expect'
export { createInterpolator, missingSecrets, referencedSecrets } from './core/interpolate'
export { perform } from './core/actions'
export {
  nullSink,
  type ArtifactSink,
  type ItemResult,
  type StepArtifactRefs,
  type StepFiles,
  type StepRef,
  type StepResult,
} from './core/artifacts'
export {
  MAX_POPUPS_PER_STEP,
  RunSetupError,
  noPopupGuard,
  runTestCase,
  type HandledPopup,
  type PopupContext,
  type PopupGuard,
  type PopupReason,
  type RunEvent,
  type RunOptions,
} from './core/run-testcase'
export { createPopupGuard, findPopups, type Popup } from './core/popup-guard'
export { LocalDirSink } from './sinks/local-dir'
export * as android from './drivers/android'
