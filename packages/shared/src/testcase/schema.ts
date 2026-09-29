import { z } from 'zod'
import { PLATFORMS } from '../element'

/**
 * `coral/testcase@1` (SPEC §7, contracts/testcase-format.md).
 * Structure only; cross-field rules (variables, permissions, platform coverage…) live in validate.ts.
 */

export const TESTCASE_SCHEMA_ID = 'coral/testcase@1'

const nonEmpty = z.string().trim().min(1)
const pct = z.number().min(0).max(1)
const pointPct = z.tuple([pct, pct])

export const STEP_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
export const TESTCASE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/
export const VARIABLE_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/i

export const DIRECTIONS = ['up', 'down', 'left', 'right'] as const
export type Direction = (typeof DIRECTIONS)[number]

/** Defaults the runner applies when a step leaves a parameter out. */
export const STEP_DEFAULTS = {
  longPressMs: 1000,
  swipeDistancePct: 0.6,
  swipeMs: 300,
  scrollDirection: 'down',
  scrollMaxSwipes: 10,
  expectTimeoutMs: 5000,
} as const

// --- locators -------------------------------------------------------------------------------

export interface RelLocator {
  below?: Locator | undefined
  above?: Locator | undefined
  left_of?: Locator | undefined
  right_of?: Locator | undefined
  class?: string | undefined
}

export interface ClassIndexLocator {
  class: string
  index: number
  within?: Locator | undefined
}

/** Exactly one key is set (SPEC §7.2). */
export interface Locator {
  android_id?: string | undefined
  ios_id?: string | undefined
  text?: string | undefined
  text_contains?: string | undefined
  desc?: string | undefined
  rel?: RelLocator | undefined
  class_index?: ClassIndexLocator | undefined
  image?: string | ImageLocator | undefined
  point_pct?: [number, number] | undefined
}

/**
 * Template-matching locator (SPEC §7.2, D27): an image in the project repo, the minimum
 * similarity, and the screen width it was cut at (contracts/testcase-image-locator.md).
 */
export interface ImageLocator {
  path: string
  threshold?: number | undefined
  screen_width?: number | undefined
}

/** Similarity an image match needs when the locator does not say (SPEC §7.2). */
export const IMAGE_DEFAULT_THRESHOLD = 0.85

/** The long form of an `image` locator, with the default threshold filled in. */
export function imageLocator(
  image: string | ImageLocator,
): Required<Omit<ImageLocator, 'screen_width'>> & Pick<ImageLocator, 'screen_width'> {
  const long = typeof image === 'string' ? { path: image } : image
  return { ...long, threshold: long.threshold ?? IMAGE_DEFAULT_THRESHOLD }
}

export const LOCATOR_KINDS = [
  'android_id',
  'ios_id',
  'text',
  'text_contains',
  'desc',
  'rel',
  'class_index',
  'image',
  'point_pct',
] as const
export type LocatorKind = (typeof LOCATOR_KINDS)[number]

const REL_DIRECTIONS = ['below', 'above', 'left_of', 'right_of'] as const

function definedKeys(value: object, keys: readonly string[]): string[] {
  return keys.filter((key) => (value as Record<string, unknown>)[key] !== undefined)
}

function exactlyOne(keys: readonly string[], what: string) {
  return (value: object, ctx: z.RefinementCtx) => {
    const present = definedKeys(value, keys)
    if (present.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message:
          present.length === 0
            ? `${what} needs exactly one of: ${keys.join(', ')}`
            : `${what} must have exactly one of ${keys.join(', ')}; got ${present.join(', ')}`,
      })
    }
  }
}

export const locatorSchema: z.ZodType<Locator> = z.lazy(() =>
  z
    .strictObject({
      android_id: nonEmpty.optional(),
      ios_id: nonEmpty.optional(),
      text: nonEmpty.optional(),
      text_contains: nonEmpty.optional(),
      desc: nonEmpty.optional(),
      rel: relSchema.optional(),
      class_index: classIndexSchema.optional(),
      image: z
        .union([
          nonEmpty,
          z.strictObject({
            path: nonEmpty,
            threshold: z.number().min(0.5).max(1).optional(),
            screen_width: z.number().int().positive().optional(),
          }),
        ])
        .optional(),
      point_pct: pointPct.optional(),
    })
    .superRefine(exactlyOne(LOCATOR_KINDS, 'locator')),
)

const relSchema: z.ZodType<RelLocator> = z.lazy(() =>
  z
    .strictObject({
      below: locatorSchema.optional(),
      above: locatorSchema.optional(),
      left_of: locatorSchema.optional(),
      right_of: locatorSchema.optional(),
      class: nonEmpty.optional(),
    })
    .superRefine(exactlyOne(REL_DIRECTIONS, 'rel')),
)

const classIndexSchema: z.ZodType<ClassIndexLocator> = z.lazy(() =>
  z.strictObject({
    class: nonEmpty,
    index: z.number().int().min(0),
    within: locatorSchema.optional(),
  }),
)

/** Ordered fallback chain; the first locator that resolves wins (P2). */
export const targetSchema = z.array(locatorSchema).min(1)

// --- expect ---------------------------------------------------------------------------------

const EXPECT_KINDS = ['visible_text', 'visible', 'not_visible', 'screen'] as const
const locatorOrList = z.union([locatorSchema, z.array(locatorSchema).min(1)])

export const expectConditionSchema = z
  .strictObject({
    visible_text: nonEmpty.optional(),
    visible: locatorOrList.optional(),
    not_visible: locatorOrList.optional(),
    screen: nonEmpty.optional(),
    timeout_ms: z.number().int().min(100).max(120_000).optional(),
  })
  .superRefine(exactlyOne(EXPECT_KINDS, 'expect condition'))
export type ExpectCondition = z.infer<typeof expectConditionSchema>

/** One condition or a list; always normalised to a list (every condition must hold). */
export const expectSchema = z.preprocess(
  (value): unknown[] => (Array.isArray(value) ? (value as unknown[]) : [value]),
  z.array(expectConditionSchema).min(1),
)

// --- steps ----------------------------------------------------------------------------------

const stepBase = {
  id: z.string().regex(STEP_ID_PATTERN, 'step id must match [A-Za-z0-9_-]{1,64}'),
  expect: expectSchema.optional(),
  snapshot: nonEmpty.optional(),
}

const launchStep = z.strictObject({ ...stepBase, action: z.literal('launch') })
const tapStep = z.strictObject({ ...stepBase, action: z.literal('tap'), target: targetSchema })
const longPressStep = z.strictObject({
  ...stepBase,
  action: z.literal('long_press'),
  target: targetSchema,
  ms: z.number().int().min(100).max(10_000).optional(),
})
const typeStep = z.strictObject({
  ...stepBase,
  action: z.literal('type'),
  target: targetSchema.optional(),
  value: z.string(),
  clear_first: z.boolean().optional(),
})
const clearStep = z.strictObject({ ...stepBase, action: z.literal('clear'), target: targetSchema })
const swipeStep = z
  .strictObject({
    ...stepBase,
    action: z.literal('swipe'),
    target: targetSchema.optional(),
    direction: z.enum(DIRECTIONS).optional(),
    distance_pct: z.number().min(0.1).max(0.95).optional(),
    from: pointPct.optional(),
    to: pointPct.optional(),
    ms: z.number().int().min(50).max(10_000).optional(),
  })
  .superRefine((step, ctx) => {
    const byDirection = step.direction !== undefined
    const byPoints = step.from !== undefined || step.to !== undefined
    if (byDirection === byPoints) {
      ctx.addIssue({ code: 'custom', message: 'swipe needs either direction or from + to' })
    } else if (byPoints && (step.from === undefined || step.to === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'swipe needs both from and to' })
    } else if (byPoints && step.distance_pct !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['distance_pct'],
        message: 'distance_pct only applies with direction',
      })
    }
  })
const scrollToStep = z.strictObject({
  ...stepBase,
  action: z.literal('scroll_to'),
  target: targetSchema,
  direction: z.enum(DIRECTIONS).optional(),
  max_swipes: z.number().int().min(1).max(50).optional(),
})
const backStep = z.strictObject({ ...stepBase, action: z.literal('back') })
const hideKeyboardStep = z.strictObject({ ...stepBase, action: z.literal('hide_keyboard') })
const waitStep = z
  .strictObject({
    ...stepBase,
    action: z.literal('wait'),
    ms: z.number().int().min(0).max(60_000).optional(),
    until: expectSchema.optional(),
  })
  .superRefine(exactlyOne(['ms', 'until'], 'wait'))
const assertStep = z.strictObject({
  ...stepBase,
  action: z.literal('assert'),
  expect: expectSchema,
})
const openDeeplinkStep = z.strictObject({
  ...stepBase,
  action: z.literal('open_deeplink'),
  url: z.string().regex(/^[a-z][a-z0-9+.-]*:\S+$/i, 'url must be an absolute URI'),
})

export const stepSchema = z.discriminatedUnion('action', [
  launchStep,
  tapStep,
  longPressStep,
  typeStep,
  clearStep,
  swipeStep,
  scrollToStep,
  backStep,
  hideKeyboardStep,
  waitStep,
  assertStep,
  openDeeplinkStep,
])
export type Step = z.infer<typeof stepSchema>
export type StepAction = Step['action']
export const STEP_ACTIONS = stepSchema.options.map((o) => o.shape.action.value)

// --- test case ------------------------------------------------------------------------------

export const APP_STATES = ['fresh', 'keep'] as const

export const testCaseSchema = z.strictObject({
  schema: z.literal(TESTCASE_SCHEMA_ID),
  id: z.string().regex(TESTCASE_ID_PATTERN, 'id must be a slug: [a-z0-9][a-z0-9-]{1,63}'),
  intent: nonEmpty,
  tags: z.array(nonEmpty).optional(),
  platforms: z.array(z.enum(PLATFORMS)).min(1),
  preconditions: z
    .strictObject({
      app_state: z.enum(APP_STATES).default('keep'),
      // Names are checked against SPEC §7.5 by validate.ts (code unknown_permission).
      grant_permissions: z.array(nonEmpty).optional(),
    })
    .optional(),
  variables: z
    .record(z.string().regex(VARIABLE_NAME_PATTERN, 'invalid variable name'), z.string())
    .optional(),
  steps: z.array(stepSchema).min(1),
})
export type TestCase = z.infer<typeof testCaseSchema>
