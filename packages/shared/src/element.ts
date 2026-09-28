import { z } from 'zod'

/** Platforms a test case can target. Only ever extended, never re-purposed (D28). */
export const PLATFORMS = ['android', 'ios'] as const
export type Platform = (typeof PLATFORMS)[number]

export const boundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().nonnegative(),
  h: z.number().nonnegative(),
})
export type Bounds = z.infer<typeof boundsSchema>

/** Android-only details kept from the UiAutomator dump (research R3). */
export const androidExtrasSchema = z.object({
  password: z.boolean(),
  focused: z.boolean(),
  scrollable: z.boolean(),
  drawing_order: z.number().int(),
  window_index: z.number().int().nonnegative(),
})
export type AndroidExtras = z.infer<typeof androidExtrasSchema>

/** Element tree node normalised across platforms (SPEC §8.1). Wire format: snake_case (D12). */
export interface ElementNode {
  /** Index path in one dump, e.g. "0.3.1" — stable only within that dump. */
  ref: string
  platform_id: string
  text: string
  desc: string
  class: string
  bounds: Bounds
  clickable: boolean
  enabled: boolean
  visible: boolean
  package_or_bundle: string
  children: ElementNode[]
  android?: AndroidExtras
}

export const elementNodeSchema: z.ZodType<ElementNode> = z.lazy(() =>
  z.object({
    ref: z.string(),
    platform_id: z.string(),
    text: z.string(),
    desc: z.string(),
    class: z.string(),
    bounds: boundsSchema,
    clickable: z.boolean(),
    enabled: z.boolean(),
    visible: z.boolean(),
    package_or_bundle: z.string(),
    children: z.array(elementNodeSchema),
    android: androidExtrasSchema.optional(),
  }),
)

/** Content of a step's `tree.json` artifact: the top-level windows of one dump. */
export const elementTreeSchema = z.array(elementNodeSchema)

/** Depth-first walk (parents before children), matching the dump order. */
export function* walkTree(nodes: readonly ElementNode[]): Generator<ElementNode> {
  for (const node of nodes) {
    yield node
    yield* walkTree(node.children)
  }
}
