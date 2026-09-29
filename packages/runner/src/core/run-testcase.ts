import {
  createRedactor,
  isPermission,
  type ElementNode,
  type FailureCode,
  type Redactor,
  type Step,
  type TestCase,
} from '@coral/shared'
import { perform } from './actions'
import {
  nullSink,
  type ArtifactSink,
  type ItemResult,
  type StepArtifactRefs,
  type StepResult,
} from './artifacts'
import { AbortError, realClock, throwIfAborted, type Clock } from './clock'
import type { DeviceDriver } from './driver'
import { StepFailure, TargetCoveredError } from './errors'
import { checkExpect } from './expect'
import { createInterpolator, missingSecrets } from './interpolate'
import { resolve, type Resolution, type ResolveContext } from './locator/resolve'
import { waitForStable } from './stability'

/** Popups handled per step before giving up with BLOCKED_BY_POPUP (D25). */
export const MAX_POPUPS_PER_STEP = 3

export interface HandledPopup {
  rule: string
  button: string
}

/** Why the guard is asked to look (§8.2): right after launch, or because the step is stuck. */
export type PopupReason = 'launch' | 'target_not_found' | 'target_covered' | 'expect_failed'

export interface PopupContext {
  appId: string
  step?: Step
  reason: PopupReason
  resolveCtx: ResolveContext
  /** MAX_POPUPS_PER_STEP already handled: a further popup means BLOCKED_BY_POPUP (D25). */
  limitReached: boolean
}

/**
 * Popup guard layer 2 (§9.2), plugged in by US4. Returns the popup it dismissed, or null when
 * there is none; throws StepFailure for screens it must not dismiss (crash, ANR, never_tap).
 */
export interface PopupGuard {
  handle(tree: ElementNode[], ctx: PopupContext): Promise<HandledPopup | null>
}

export const noPopupGuard: PopupGuard = { handle: () => Promise.resolve(null) }

export type RunEvent =
  { type: 'step'; testCase: string; result: StepResult } | { type: 'item'; result: ItemResult }

export interface RunOptions {
  driver: DeviceDriver
  testCase: TestCase
  /** Package / bundle id under test. */
  appId: string
  secrets?: Readonly<Record<string, string | undefined>>
  build?: { path: string; sha256: string }
  sink?: ArtifactSink
  popupGuard?: PopupGuard
  clock?: Clock
  stableTimeoutMs?: number
  signal?: AbortSignal
  onEvent?: (event: RunEvent) => void
}

/** Problems found before touching the device: the CLI exits 2, the agent reports an error. */
export class RunSetupError extends Error {
  constructor(
    readonly code: 'platform_mismatch' | 'missing_secrets',
    message: string,
  ) {
    super(message)
    this.name = 'RunSetupError'
  }
}

/** Replaces `${…}` in every string of the step. */
function interpolateStep(step: Step, interpolate: (text: string) => string): Step {
  const map = (value: unknown): unknown => {
    if (typeof value === 'string') return interpolate(value)
    if (Array.isArray(value)) return value.map(map)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, map(v)]))
    }
    return value
  }
  return map(step) as Step
}

const needsResolvedTarget = (step: Step): boolean =>
  'target' in step && step.target !== undefined && step.action !== 'scroll_to'

/**
 * Runs one test case deterministically (SPEC §8.2): prepare the device, then for every step wait
 * for a stable screen → resolve → act → check expect → save evidence; stop at the first failure.
 */
export async function runTestCase(options: RunOptions): Promise<ItemResult> {
  const { driver, testCase, appId } = options
  const clock = options.clock ?? realClock
  const sink = options.sink ?? nullSink
  const guard = options.popupGuard ?? noPopupGuard
  const signal = options.signal
  const secrets = options.secrets ?? {}

  if (!testCase.platforms.includes(driver.platform)) {
    throw new RunSetupError(
      'platform_mismatch',
      `test case ${testCase.id} does not target ${driver.platform} (platforms: ${testCase.platforms.join(', ')})`,
    )
  }
  const missing = missingSecrets(testCase, secrets)
  if (missing.length > 0) {
    throw new RunSetupError('missing_secrets', `missing secrets: ${missing.join(', ')}`)
  }
  const interpolate = createInterpolator(testCase, secrets)
  // Mask every secret handed to the run, not only the ones this test case references (D19).
  const redactor: Redactor = createRedactor([
    ...interpolate.secretValues,
    ...Object.values(secrets).filter((v): v is string => v !== undefined),
  ])

  const startedAt = clock.now()
  const steps: StepResult[] = []
  const finish = async (
    status: ItemResult['status'],
    failure?: { code?: FailureCode; message: string },
  ): Promise<ItemResult> => {
    const result: ItemResult = redactor.value({
      test_case: testCase.id,
      status,
      ...(failure?.code ? { failure_code: failure.code } : {}),
      ...(failure ? { message: failure.message } : {}),
      started_at: new Date(startedAt).toISOString(),
      duration_ms: clock.now() - startedAt,
      steps,
    })
    await sink.saveResult(result)
    options.onEvent?.({ type: 'item', result })
    return result
  }

  const size = await safe(() => driver.windowSize())
  if (!size.ok) return finish('error', { code: 'DRIVER_ERROR', message: size.error })
  const resolveCtx: ResolveContext = { platform: driver.platform, screen: size.value, appId }
  const stable = () =>
    waitForStable(driver, clock, {
      ...(options.stableTimeoutMs ? { timeoutMs: options.stableTimeoutMs } : {}),
      ...(signal ? { signal } : {}),
    })

  // Preconditions (§8.3, §9.1, research R7).
  const prepared = await safe(async () => {
    if (options.build) await driver.install(options.build.path, options.build.sha256)
    if (testCase.preconditions?.app_state === 'fresh') await driver.resetApp(appId)
    const permissions = (testCase.preconditions?.grant_permissions ?? []).filter(isPermission)
    if (permissions.length > 0) await driver.grantPermissions(appId, permissions)
  })
  if (!prepared.ok) return finish('error', { code: 'DRIVER_ERROR', message: prepared.error })

  for (const [index, rawStep] of testCase.steps.entries()) {
    const stepStart = clock.now()
    const logSince = Date.now()
    const step = interpolateStep(rawStep, interpolate)
    const popups: HandledPopup[] = []
    let tree: ElementNode[] = []
    let unstable = false
    let target: Resolution | undefined

    /** One more popup for this step; false when there is none on screen. */
    const tryPopup = async (reason: PopupReason): Promise<boolean> => {
      const handled = await guard.handle(tree, {
        appId,
        step,
        reason,
        resolveCtx,
        limitReached: popups.length >= MAX_POPUPS_PER_STEP,
      })
      if (!handled) return false
      popups.push(handled)
      ;({ tree } = await stable())
      return true
    }

    let failure: StepFailure | undefined
    try {
      ;({ tree, unstable } = await stable())

      if (needsResolvedTarget(step) && 'target' in step && step.target) {
        const chain = step.target
        target = resolve(chain, tree, resolveCtx)
        while (!target && (await tryPopup('target_not_found')))
          target = resolve(chain, tree, resolveCtx)
        if (!target) throw new StepFailure('TARGET_NOT_FOUND', 'no locator of the target matched')
      }

      for (;;) {
        try {
          const outcome = await perform(
            { step, tree, ...(target ? { target } : {}) },
            {
              driver,
              clock,
              resolveCtx,
              appId,
              ...(options.stableTimeoutMs ? { stableTimeoutMs: options.stableTimeoutMs } : {}),
              ...(signal ? { signal } : {}),
            },
          )
          if (outcome.target) target = outcome.target
          break
        } catch (error) {
          if (!(error instanceof TargetCoveredError) || !(await tryPopup('target_covered'))) {
            throw error
          }
          if ('target' in step && step.target) target = resolve(step.target, tree, resolveCtx)
          if (!target) throw new StepFailure('TARGET_NOT_FOUND', 'target gone after popup')
        }
      }

      // Popups right after launch (D25).
      if (step.action === 'launch') {
        ;({ tree } = await stable())
        while (await tryPopup('launch'));
      }

      if (step.expect) {
        const expectOptions = signal ? { signal } : {}
        let outcome = await checkExpect(step.expect, driver, clock, resolveCtx, expectOptions)
        tree = outcome.tree
        while (!outcome.ok && (await tryPopup('expect_failed'))) {
          outcome = await checkExpect(step.expect, driver, clock, resolveCtx, expectOptions)
          tree = outcome.tree
        }
        if (!outcome.ok) throw new StepFailure('EXPECT_FAILED', outcome.message ?? 'expect failed')
      } else {
        throwIfAborted(signal)
        tree = await driver.tree()
      }
    } catch (error) {
      if (error instanceof AbortError) {
        return finish('error', { message: 'cancelled' })
      }
      failure =
        error instanceof StepFailure
          ? error
          : new StepFailure('DRIVER_ERROR', error instanceof Error ? error.message : String(error))
    }

    // Evidence for every step; the device log only when it failed (§8.6).
    const shot = await safe(() => driver.screenshot())
    const log = failure ? await safe(() => driver.deviceLogs(logSince)) : undefined
    const artifacts: StepArtifactRefs = await sink.saveStep(
      testCase.id,
      { index, id: step.id },
      {
        ...(shot.ok ? { screenshot: shot.value } : {}),
        tree: redactor.value(tree),
        ...(log?.ok ? { log: redactor.text(log.value) } : {}),
      },
    )

    const result: StepResult = redactor.value({
      step_index: index,
      step_id: step.id,
      action: step.action,
      status: failure ? 'failed' : 'passed',
      locator_used_index: target?.index ?? null,
      degraded: target?.degraded ?? false,
      unstable,
      duration_ms: clock.now() - stepStart,
      ...(failure ? { failure_code: failure.code, message: failure.message } : {}),
      popups_handled: popups,
      artifacts,
    })
    steps.push(result)
    options.onEvent?.({ type: 'step', testCase: testCase.id, result })
    if (failure) return finish('failed', { code: failure.code, message: failure.message })
  }
  return finish('passed')
}

type Safe<T> = { ok: true; value: T } | { ok: false; error: string }

async function safe<T>(fn: () => Promise<T>): Promise<Safe<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
