/**
 * Deterministic runner shared by coral-agent and `coral run` (SPEC §8, D09).
 * No AI here: this package must never depend on @coral/brain or an LLM SDK (SPEC P1, D08).
 */
export const RUNNER_PACKAGE = '@coral/runner'

export type {
  DeviceDriver,
  ForegroundActivity,
  FrameOptions,
  FrameSource,
  LiveFrame,
  Point,
  RemoteControl,
  Size,
  TargetLifecycle,
  UiDriver,
} from './core/driver'
export { imageInfo, type ImageInfo } from './core/image/size'
export {
  AI_IMAGE_MAX_EDGE,
  AI_JPEG_QUALITY,
  downscaleRgb,
  observedImagesFromPng,
  type ObservedImages,
} from './core/image/downscale'
export { type ImageMatcher, type Match, type MatchOptions } from './core/image/matcher'
export { openCvMatcher } from './core/image/opencv'
export { realClock, AbortError, type Clock } from './core/clock'
export { StepFailure, TargetCoveredError } from './core/errors'
export { resolve, findAll, type Resolution, type ResolveContext } from './core/locator/resolve'
export { checkHit, topNodeAt, touchTargetAt } from './core/hit-test'
export { waitForStable, structureHash } from './core/stability'
export { checkExpect, expectFailure } from './core/expect'
export { createInterpolator, missingSecrets, referencedSecrets } from './core/interpolate'
export { directionPath, perform } from './core/actions'
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
export { pickTarget } from './core/recorder/pick'
export { extractLocators, type LocatorOptions } from './core/recorder/locators'
export { MAX_SUGGESTIONS, suggestExpects } from './core/recorder/suggest'
export { snapshotFromPng, type ScreenSnapshot } from './core/recorder/crop'
export { LocalDirSink } from './sinks/local-dir'
export * as android from './drivers/android'
export {
  CRASH_LOG_WINDOW_MS,
  LONG_PRESS_MS,
  RecorderError,
  SWIPE_MS,
  crashExcerpt,
  inspect,
  observe,
  prepare,
  record,
  type RecorderDeps,
} from './commands/recorder'
