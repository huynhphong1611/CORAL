import { STEP_DEFAULTS, type Bounds, type ElementNode, type Step } from '@coral/shared'
import type { Clock } from './clock'
import type { DeviceDriver, Point } from './driver'
import { StepFailure, TargetCoveredError } from './errors'
import { checkExpect } from './expect'
import { checkHit } from './hit-test'
import { resolve, type Resolution, type ResolveContext } from './locator/resolve'
import { waitForStable } from './stability'

export interface ActionContext {
  driver: DeviceDriver
  clock: Clock
  resolveCtx: ResolveContext
  appId: string
  stableTimeoutMs?: number
  signal?: AbortSignal
}

export interface ActionInput {
  /** The step with `${…}` already replaced. */
  step: Step
  /** Resolved target (every action with a target except scroll_to). */
  target?: Resolution
  /** Tree the target was resolved in, used for the hit-test. */
  tree: ElementNode[]
}

export interface ActionOutcome {
  /** scroll_to: the element it scrolled to. */
  target?: Resolution
}

/** Taps are only sent when the top node at the point is the target (§8.4). */
function assertOnTop(input: ActionInput): Point {
  const { target, tree } = input
  if (!target) throw new StepFailure('TARGET_NOT_FOUND', 'step needs a target')
  if (target.node) {
    const hit = checkHit(tree, target.node, target.point)
    if (!hit.ok) throw new TargetCoveredError(hit.covering)
  }
  return target.point
}

function pointIn(region: Bounds, [px, py]: [number, number]): Point {
  return { x: Math.round(region.x + px * region.w), y: Math.round(region.y + py * region.h) }
}

/** Finger path for a swipe in `direction` covering `distance` of the region, centred. */
export function directionPath(
  region: Bounds,
  direction: 'up' | 'down' | 'left' | 'right',
  distance: number,
): [Point, Point] {
  const half = distance / 2
  switch (direction) {
    case 'up':
      return [pointIn(region, [0.5, 0.5 + half]), pointIn(region, [0.5, 0.5 - half])]
    case 'down':
      return [pointIn(region, [0.5, 0.5 - half]), pointIn(region, [0.5, 0.5 + half])]
    case 'left':
      return [pointIn(region, [0.5 + half, 0.5]), pointIn(region, [0.5 - half, 0.5])]
    case 'right':
      return [pointIn(region, [0.5 - half, 0.5]), pointIn(region, [0.5 + half, 0.5])]
  }
}

/** To reveal content further `direction`, the finger moves the other way. */
const SCROLL_FINGER = { down: 'up', up: 'down', right: 'left', left: 'right' } as const

async function screenRegion(driver: DeviceDriver): Promise<Bounds> {
  const size = await driver.windowSize()
  return { x: 0, y: 0, w: size.width, h: size.height }
}

/** Performs one action of §7.1 (expect is checked by the caller). */
export async function perform(input: ActionInput, ctx: ActionContext): Promise<ActionOutcome> {
  const { step } = input
  const { driver } = ctx
  switch (step.action) {
    case 'launch':
      await driver.launch(ctx.appId)
      return {}
    case 'tap':
      await driver.tapAt(assertOnTop(input))
      return {}
    case 'long_press':
      await driver.longPressAt(assertOnTop(input), step.ms ?? STEP_DEFAULTS.longPressMs)
      return {}
    case 'type':
      if (step.target) await driver.tapAt(assertOnTop(input))
      if (step.clear_first) await driver.clearText()
      await driver.type(step.value)
      return {}
    case 'clear':
      await driver.tapAt(assertOnTop(input))
      await driver.clearText()
      return {}
    case 'swipe': {
      const region = input.target?.node?.bounds ?? (await screenRegion(driver))
      const [from, to] =
        step.from && step.to
          ? [pointIn(region, step.from), pointIn(region, step.to)]
          : directionPath(
              region,
              step.direction ?? 'up',
              step.distance_pct ?? STEP_DEFAULTS.swipeDistancePct,
            )
      await driver.swipe(from, to, step.ms ?? STEP_DEFAULTS.swipeMs)
      return {}
    }
    case 'scroll_to':
      return { target: await scrollTo(step, input.tree, ctx) }
    case 'back':
      await driver.back()
      return {}
    case 'hide_keyboard':
      await driver.hideKeyboard()
      return {}
    case 'wait':
      if (step.until) {
        const result = await checkExpect(step.until, driver, ctx.clock, ctx.resolveCtx, {
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
        if (!result.ok) throw new StepFailure('EXPECT_FAILED', result.message ?? 'wait timed out')
      } else {
        await ctx.clock.sleep(step.ms ?? 0, ctx.signal)
      }
      return {}
    case 'assert':
      return {}
    case 'open_deeplink':
      await driver.openDeepLink(step.url)
      return {}
  }
}

async function scrollTo(
  step: Extract<Step, { action: 'scroll_to' }>,
  initialTree: ElementNode[],
  ctx: ActionContext,
): Promise<Resolution> {
  const maxSwipes = step.max_swipes ?? STEP_DEFAULTS.scrollMaxSwipes
  const finger = SCROLL_FINGER[step.direction ?? STEP_DEFAULTS.scrollDirection]
  let tree = initialTree
  for (let swipes = 0; ; swipes += 1) {
    const found = resolve(step.target, tree, ctx.resolveCtx)
    if (found) return found
    if (swipes >= maxSwipes) break
    const [from, to] = directionPath(await screenRegion(ctx.driver), finger, 0.5)
    await ctx.driver.swipe(from, to, STEP_DEFAULTS.swipeMs)
    tree = (
      await waitForStable(ctx.driver, ctx.clock, {
        ...(ctx.stableTimeoutMs ? { timeoutMs: ctx.stableTimeoutMs } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
    ).tree
  }
  throw new StepFailure('TARGET_NOT_FOUND', `not found after ${maxSwipes} swipes`)
}
