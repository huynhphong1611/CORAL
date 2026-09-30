import { z } from 'zod'
import { deviceSchema } from './agents'
import { timestamp } from './common'

/**
 * What a device is busy with, from its open lease (FR-003, data-model §2): shown on the devices
 * page and returned with 409 `device_busy`.
 */
export const deviceActivitySchema = z.object({
  kind: z.enum(['idle', 'run', 'live', 'recording', 'offline']),
  by: z.object({ user_id: z.uuid(), name: z.string() }).optional(),
  run_id: z.uuid().optional(),
  since: timestamp.optional(),
})
export type DeviceActivity = z.infer<typeof deviceActivitySchema>

/** `GET /devices` and `devices.updated` from Phase 2 on. */
export const deviceViewSchema = deviceSchema.extend({ activity: deviceActivitySchema })
export type DeviceView = z.infer<typeof deviceViewSchema>

/** `POST|GET /devices/:id/control` (research R7). */
export const controlSessionSchema = z.object({
  live_session_id: z.uuid(),
  device_id: z.uuid(),
  user: z.object({ id: z.uuid(), name: z.string() }),
  started_at: timestamp,
  expires_at: timestamp,
  idle_timeout_ms: z.number().int().positive(),
})
export type ControlSession = z.infer<typeof controlSessionSchema>

/** Error codes added in Phase 2 (contracts/rest-api-phase2.md, ui-ws.md). */
export const PHASE2_ERROR_CODES = [
  'forbidden',
  'device_busy',
  'device_offline',
  'not_holder',
  'session_ended',
  'slug_exists',
  'image_not_found',
  'secret_required',
] as const

/** Body of 409 `device_busy`: the usual error plus what the device is doing. */
export const deviceBusyErrorSchema = z.object({
  error: z.object({
    code: z.literal('device_busy'),
    message: z.string(),
    activity: deviceActivitySchema,
  }),
})
