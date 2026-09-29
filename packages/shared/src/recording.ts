import { stringify } from 'yaml'
import { z } from 'zod'
import {
  TESTCASE_SCHEMA_ID,
  expectConditionSchema,
  stepSchema,
  type Locator,
  type Step,
  type TestCase,
} from './testcase/schema'
import {
  validateTestCaseSource,
  type TestCaseCheckOptions,
  type ValidationResult,
} from './testcase/validate'

/** Warnings the Recorder attaches to a step (FR-013a, FR-015). */
export const RECORDING_WARNINGS = ['no_expect_after_tap', 'never_tap'] as const

/**
 * One recorded step (data-model §3): exactly one `coral/testcase@1` step, the expectations the
 * Recorder suggested for it, and the snapshot it took before acting (object keys under
 * `<tenant>/recordings/<id>/<n>/`, screen size in device pixels).
 */
export const recordingStepSchema = z.object({
  n: z.number().int().positive(),
  step: stepSchema,
  suggestions: z.array(expectConditionSchema).max(3),
  warnings: z.array(z.enum(RECORDING_WARNINGS)),
  snapshot: z.object({
    screen: z.string().min(1),
    tree: z.string().min(1),
    element: z.string().min(1).optional(),
    screen_width: z.number().int().positive(),
    screen_height: z.number().int().positive(),
  }),
  recorded_at: z.iso.datetime({ offset: true }),
})
export type RecordingStep = z.infer<typeof recordingStepSchema>

/** Where a recorded step's element image lives in the project repo (data-model §4). */
export function snapshotPath(
  slug: string,
  stepId: string,
  file: 'screen.jpg' | 'tree.json' | 'element.png',
): string {
  return `snap/${slug}/${stepId}/${file}`
}

const RECORDED_IMAGE = /^snap\/[^/]+\/([^/]+)\/element\.png$/

/** Points an image locator the Recorder wrote at the snapshot folder of `slug`. */
function withSlug(locator: Locator, slug: string): Locator {
  if (locator.image === undefined) return locator
  const image = typeof locator.image === 'string' ? { path: locator.image } : locator.image
  const match = RECORDED_IMAGE.exec(image.path)
  if (!match?.[1]) return locator
  const path = snapshotPath(slug, match[1], 'element.png')
  return { image: typeof locator.image === 'string' ? path : { ...image, path } }
}

function rewriteImages(step: Step, slug: string): Step {
  if (!('target' in step) || !step.target) return step
  return { ...step, target: step.target.map((locator) => withSlug(locator, slug)) }
}

export interface RecordingToYamlInput {
  slug: string
  intent: string
  steps: readonly Pick<RecordingStep, 'step'>[]
  preconditions?: TestCase['preconditions']
}

/**
 * The `coral/testcase@1` YAML of a recording (FR-017): id = slug, Android, a fresh app by default,
 * image locators under `snap/<slug>/<step_id>/`, secrets only as `${secret:NAME}` (they are already
 * in that form in the steps). The result is validated exactly like `coral validate`.
 */
export function recordingToYaml(
  input: RecordingToYamlInput,
  options: TestCaseCheckOptions = {},
): { yaml: string; validation: ValidationResult<TestCase> } {
  const document = {
    schema: TESTCASE_SCHEMA_ID,
    id: input.slug,
    intent: input.intent,
    platforms: ['android'],
    preconditions: input.preconditions ?? { app_state: 'fresh' },
    steps: input.steps.map(({ step }) => rewriteImages(step, input.slug)),
  }
  const yaml = stringify(document, { lineWidth: 0 })
  return { yaml, validation: validateTestCaseSource(yaml, `${input.slug}.yaml`, options) }
}
