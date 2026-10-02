import { z } from 'zod'
import { ROLES } from '../api/auth'
import {
  EXPLORATION_STATUSES,
  STOP_REASONS,
  explorationStatsSchema,
  explorationStepSchema,
  fingerprintSchema,
  screenIdSchema,
} from '../api/explorations'
import {
  IMPORT_ITEM_REASONS,
  IMPORT_ITEM_STATUSES,
  IMPORT_JOB_STATUSES,
  importStatsSchema,
} from '../api/imports'
import { deviceViewSchema } from '../api/live'
import { RUN_ITEM_STATUSES, RUN_STATUSES } from '../api/runs'
import { elementNodeSchema } from '../element'
import { FAILURE_CODES } from '../failure-codes'
import { recordingStepSchema } from '../recording'
import { locatorSchema } from '../testcase/schema'
import type { PROTOCOL_VERSION } from './envelope'
import { deviceCommandSchema, secretNameSchema } from './device-command'
import { parseEnvelope, type ParseFailure } from './parse'

/** Largest JSON message on `WS /ws/ui`; live-view frames are separate binary frames. */
export const MAX_UI_MESSAGE_BYTES = 256 * 1024

const failureCode = z.enum(FAILURE_CODES)
const uuid = z.uuid()

/** A live command or inspection belongs to exactly one live session or one recording. */
const oneHolder = <T extends { live_session_id?: string; recording_id?: string }>(p: T) =>
  (p.live_session_id === undefined) !== (p.recording_id === undefined)
const holder = { live_session_id: uuid.optional(), recording_id: uuid.optional() }
const holderMessage = { message: 'exactly one of live_session_id or recording_id' }

/** Payloads of `WS /ws/ui` (contracts/ui-ws.md). C = browser, S = server. */
export const uiPayloadSchemas = {
  'ui.auth': z.object({ access_token: z.string().min(1).max(8192) }),
  'ui.ready': z.object({ user_id: uuid, tenant_id: uuid, role: z.enum(ROLES) }),
  'run.watch': z.object({ run_id: uuid }),
  'run.unwatch': z.object({ run_id: uuid }),
  'run.updated': z.object({
    run_id: uuid,
    status: z.enum(RUN_STATUSES),
    failure_code: failureCode.optional(),
    items: z.array(
      z.object({
        id: uuid,
        status: z.enum(RUN_ITEM_STATUSES),
        failure_code: failureCode.optional(),
        failed_step_id: z.string().optional(),
      }),
    ),
    started_at: z.iso.datetime({ offset: true }).optional(),
    finished_at: z.iso.datetime({ offset: true }).optional(),
  }),
  'run.step': z.object({
    run_id: uuid,
    run_item_id: uuid,
    step_index: z.number().int().nonnegative(),
    step_id: z.string().min(1),
    status: z.enum(['passed', 'failed']),
    failure_code: failureCode.optional(),
    degraded: z.boolean(),
    duration_ms: z.number().int().nonnegative(),
  }),
  'devices.updated': z.object({ devices: z.array(deviceViewSchema) }),
  'stream.subscribe': z.object({ device_id: uuid }),
  'stream.unsubscribe': z.object({ device_id: uuid }),
  'stream.status': z.object({
    device_id: uuid,
    state: z.enum(['starting', 'live', 'stalled', 'stopped']),
    reason: z.string().optional(),
  }),
  'live.command': z
    .object({ ...holder, command: deviceCommandSchema, record: z.boolean().optional() })
    .refine(oneHolder, holderMessage)
    .refine((p) => !p.record || p.recording_id !== undefined, {
      message: 'record: true needs recording_id',
    }),
  'live.result': z.object({
    ok: z.boolean(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
    command_id: uuid,
    duration_ms: z.number().int().nonnegative(),
  }),
  'recording.step': z
    .object({
      recording_id: uuid,
      step: recordingStepSchema.optional(),
      popup_rule: z.string().min(1).optional(),
      secret_hint: z.object({ name: secretNameSchema }).optional(),
    })
    // A tap a popup rule handles is done but recorded as no step (FR-015).
    .refine((p) => (p.step === undefined) !== (p.popup_rule === undefined), {
      message: 'exactly one of step or popup_rule',
    }),
  'live.ended': z
    .object({
      ...holder,
      reason: z.enum(['idle_timeout', 'agent_offline', 'released', 'replaced_by_recording']),
    })
    .refine(oneHolder, holderMessage),
  'live.inspect': z
    .object({ ...holder, x: z.number().int().min(0), y: z.number().int().min(0) })
    .refine(oneHolder, holderMessage),
  'live.inspected': z.object({
    element: elementNodeSchema,
    locators: z.array(locatorSchema),
    text: z.string(),
  }),
  // Explorer and imports (contracts/ui-ws-phase3.md).
  'exploration.watch': z.object({ exploration_id: uuid }),
  'exploration.unwatch': z.object({ exploration_id: uuid }),
  'exploration.updated': z.object({
    exploration_id: uuid,
    status: z.enum(EXPLORATION_STATUSES),
    stop_reason: z.enum(STOP_REASONS).optional(),
    stats: explorationStatsSchema,
    current: z
      .object({
        n: z.number().int().positive(),
        screen_name: z.string().optional(),
        action_summary: z.string().max(200),
      })
      .optional(),
  }),
  'exploration.step': z.object({ exploration_id: uuid, step: explorationStepSchema }),
  'exploration.screen': z.object({
    exploration_id: uuid,
    screen: z.object({
      id: screenIdSchema,
      name: z.string().min(1),
      fingerprint: fingerprintSchema,
      is_new: z.boolean(),
    }),
  }),
  'import.watch': z.object({ import_job_id: uuid }),
  'import.unwatch': z.object({ import_job_id: uuid }),
  'import.updated': z.object({
    import_job_id: uuid,
    status: z.enum(IMPORT_JOB_STATUSES),
    stats: importStatsSchema,
    item: z
      .object({
        n: z.number().int().positive(),
        status: z.enum(IMPORT_ITEM_STATUSES),
        reason: z.enum(IMPORT_ITEM_REASONS).optional(),
      })
      .optional(),
  }),
  error: z.object({ code: z.string(), message: z.string() }),
} as const

export type UiMessageType = keyof typeof uiPayloadSchemas
export type UiPayload<T extends UiMessageType> = z.infer<(typeof uiPayloadSchemas)[T]>

/** Replies carry `re` = id of the message they answer (D18). */
export const UI_REPLY_TYPES: ReadonlySet<UiMessageType> = new Set([
  'ui.ready',
  'live.result',
  'live.inspected',
])

/** Who sends each type: C = browser, S = server. */
export const UI_MESSAGE_DIRECTION: Record<UiMessageType, 'C→S' | 'S→C' | 'both'> = {
  'ui.auth': 'C→S',
  'ui.ready': 'S→C',
  'run.watch': 'C→S',
  'run.unwatch': 'C→S',
  'run.updated': 'S→C',
  'run.step': 'S→C',
  'devices.updated': 'S→C',
  'stream.subscribe': 'C→S',
  'stream.unsubscribe': 'C→S',
  'stream.status': 'S→C',
  'live.command': 'C→S',
  'live.result': 'S→C',
  'recording.step': 'S→C',
  'live.ended': 'S→C',
  'live.inspect': 'C→S',
  'live.inspected': 'S→C',
  'exploration.watch': 'C→S',
  'exploration.unwatch': 'C→S',
  'exploration.updated': 'S→C',
  'exploration.step': 'S→C',
  'exploration.screen': 'S→C',
  'import.watch': 'C→S',
  'import.unwatch': 'C→S',
  'import.updated': 'S→C',
  error: 'both',
}

export type UiMessage = {
  [T in UiMessageType]: {
    v: typeof PROTOCOL_VERSION
    type: T
    id: string
    ts: number
    re?: string
    payload: UiPayload<T>
  }
}[UiMessageType]

export type UiParseResult = { ok: true; message: UiMessage } | ParseFailure

/** Parses and validates one raw `WS /ws/ui` text frame (256 KB). Never throws. */
export function parseUiMessage(raw: string): UiParseResult {
  const parsed = parseEnvelope(raw, {
    schemas: uiPayloadSchemas,
    replyTypes: UI_REPLY_TYPES,
    maxBytes: MAX_UI_MESSAGE_BYTES,
  })
  if (!parsed.ok) return parsed
  return {
    ok: true,
    message: { ...parsed.envelope, type: parsed.type, payload: parsed.payload } as UiMessage,
  }
}
