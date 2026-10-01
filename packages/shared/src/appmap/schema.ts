import { z } from 'zod'
import { stepSchema, type Step } from '../testcase/schema'

/** `coral/appmap@1` — screens and transitions found by the Explorer (SPEC §10, contracts/appmap.md). */
export const APPMAP_SCHEMA_ID = 'coral/appmap@1'
export const MAX_APPMAP_SCREENS = 500
export const MAX_APPMAP_TRANSITIONS = 5000
export const SCREEN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,49}$/
export const FINGERPRINT_PATTERN = /^[0-9a-f]{16}$/

const nonEmpty = z.string().trim().min(1)
const isoDate = z.iso.datetime({ offset: true })
const screenId = z.string().regex(SCREEN_ID_PATTERN, 'screen id: [a-z0-9-], at most 50')

export const appMapScreenSchema = z.strictObject({
  id: screenId,
  name: nonEmpty.max(60),
  fingerprint: z.string().regex(FINGERPRINT_PATTERN, '16 hex characters'),
  package: nonEmpty,
  activity: nonEmpty.optional(),
  /** Repo directory with screen.jpg and tree.json, e.g. appmap/snap/<id>. */
  snapshot: nonEmpty,
  first_seen_at: isoDate,
  seen_in: z.array(z.string()).default([]),
})
export type AppMapScreen = z.infer<typeof appMapScreenSchema>

/** A recorded step without id and expectation: how to go from one screen to the next. */
export type TransitionAction = Omit<Step, 'id' | 'expect' | 'snapshot'>

export const transitionActionSchema = z.custom<TransitionAction>((value) => {
  if (typeof value !== 'object' || value === null) return false
  if ('id' in value || 'expect' in value || 'snapshot' in value) return false
  return stepSchema.safeParse({ ...value, id: 'transition' }).success
}, 'a coral/testcase@1 step without id, expect or snapshot')

export const appMapTransitionSchema = z.strictObject({
  from: screenId,
  to: screenId,
  action: transitionActionSchema,
  seen_in: z.array(z.string()).default([]),
})
export type AppMapTransition = z.infer<typeof appMapTransitionSchema>

export const appMapSchema = z
  .strictObject({
    schema: z.literal(APPMAP_SCHEMA_ID),
    screens: z.array(appMapScreenSchema).max(MAX_APPMAP_SCREENS),
    transitions: z.array(appMapTransitionSchema).max(MAX_APPMAP_TRANSITIONS),
  })
  .superRefine((map, ctx) => {
    const ids = new Set<string>()
    const fingerprints = new Set<string>()
    map.screens.forEach((screen, i) => {
      if (ids.has(screen.id)) {
        ctx.addIssue({ code: 'custom', path: ['screens', i, 'id'], message: 'duplicate screen id' })
      }
      if (fingerprints.has(screen.fingerprint)) {
        ctx.addIssue({
          code: 'custom',
          path: ['screens', i, 'fingerprint'],
          message: 'two screens have the same fingerprint',
        })
      }
      ids.add(screen.id)
      fingerprints.add(screen.fingerprint)
    })
    map.transitions.forEach((t, i) => {
      for (const end of ['from', 'to'] as const) {
        if (!ids.has(t[end])) {
          ctx.addIssue({
            code: 'custom',
            path: ['transitions', i, end],
            message: `unknown screen "${t[end]}"`,
          })
        }
      }
    })
  })
export type AppMap = z.infer<typeof appMapSchema>

export const EMPTY_APPMAP: AppMap = { schema: APPMAP_SCHEMA_ID, screens: [], transitions: [] }

/** ASCII slug of a screen name for its id (Vietnamese letters lose their marks): "Danh sách" → "danh-sach". */
export function screenSlug(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '')
  return slug || 'screen'
}
