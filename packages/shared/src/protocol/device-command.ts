import { z } from 'zod'

/** Device pixels: the browser maps canvas clicks with the frame's device size (contracts/ui-ws.md). */
const coord = z.number().int().min(0).max(100_000)
export const pointSchema = z.object({ x: coord, y: coord })

/** Names of secrets (`${secret:NAME}`, dev env `CORAL_SECRET_<NAME>`). */
export const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
export const secretNameSchema = z
  .string()
  .regex(SECRET_NAME_PATTERN, 'secret name must match [A-Za-z_][A-Za-z0-9_]*')

/**
 * What a person may do to a held device (FR-008). A closed list: anything else is rejected
 * (FR-009, P6). `type` carries either the text or the name of a secret the server fills in, so a
 * password never passes through the browser (FR-014).
 */
export const deviceCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('tap'), x: coord, y: coord }),
  z.strictObject({
    kind: z.literal('long_press'),
    x: coord,
    y: coord,
    ms: z.number().int().min(100).max(10_000).optional(),
  }),
  z.strictObject({
    kind: z.literal('swipe'),
    from: pointSchema,
    to: pointSchema,
    ms: z.number().int().min(50).max(10_000).optional(),
  }),
  z
    .strictObject({
      kind: z.literal('type'),
      text: z.string().min(1).max(10_000).optional(),
      secret: secretNameSchema.optional(),
    })
    .refine((c) => (c.text === undefined) !== (c.secret === undefined), {
      message: 'type carries exactly one of text or secret',
    }),
  z.strictObject({ kind: z.literal('back') }),
  z.strictObject({ kind: z.literal('home') }),
  z.strictObject({ kind: z.literal('hide_keyboard') }),
  z.strictObject({ kind: z.literal('restart_app') }),
])
export type DeviceCommand = z.infer<typeof deviceCommandSchema>
export type DeviceCommandKind = DeviceCommand['kind']
