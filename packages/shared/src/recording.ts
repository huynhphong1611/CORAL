import { z } from 'zod'
import { expectConditionSchema, stepSchema } from './testcase/schema'

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
