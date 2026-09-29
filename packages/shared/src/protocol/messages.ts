import { z } from 'zod'
import { FAILURE_CODES } from '../failure-codes'
import { STEP_ID_PATTERN } from '../testcase/schema'
import type { PROTOCOL_VERSION } from './envelope'
import { MAX_MESSAGE_BYTES, envelopeSchema } from './envelope'

// ---- shared payload parts (contracts/ws-protocol.md) --------------------------------------------

export const deviceInfoSchema = z.object({
  udid: z.string().min(1),
  platform: z.literal('android'),
  kind: z.enum(['emulator', 'real']),
  model: z.string(),
  os_version: z.string(),
  api_level: z.number().int().positive(),
  status: z.enum(['idle', 'busy', 'offline']),
})
export type DeviceInfo = z.infer<typeof deviceInfoSchema>

export const failureCodeSchema = z.enum(FAILURE_CODES)

/** Same rule as test case step ids; it becomes part of artifact keys (data-model §4). */
const stepIdSchema = z.string().regex(STEP_ID_PATTERN, 'step id must match [A-Za-z0-9_-]{1,64}')

export const stepResultSchema = z.object({
  step_index: z.number().int().nonnegative(),
  step_id: stepIdSchema,
  action: z.string().min(1),
  status: z.enum(['passed', 'failed']),
  locator_used_index: z.number().int().nonnegative().nullable(),
  degraded: z.boolean(),
  unstable: z.boolean(),
  duration_ms: z.number().int().nonnegative(),
  failure_code: failureCodeSchema.optional(),
  message: z.string().optional(),
  popups_handled: z.array(z.object({ rule: z.string(), button: z.string() })),
  artifacts: z.object({
    screenshot: z.string().optional(),
    tree: z.string().optional(),
    log: z.string().optional(),
  }),
})
export type StepResult = z.infer<typeof stepResultSchema>

const itemStatus = z.enum(['passed', 'failed', 'error'])

// ---- message payloads -------------------------------------------------------------------------------

export const payloadSchemas = {
  'agent.hello': z.object({
    agent_version: z.string(),
    os: z.string(),
    arch: z.string(),
    capabilities: z.object({ platforms: z.array(z.literal('android')), u2_jar: z.string() }),
    devices: z.array(deviceInfoSchema),
  }),
  'agent.welcome': z.object({ agent_id: z.uuid(), heartbeat_ms: z.number().int().positive() }),
  'agent.heartbeat': z.object({
    devices: z.array(z.object({ udid: z.string(), status: deviceInfoSchema.shape.status })),
  }),
  'device.update': z.object({
    added: z.array(deviceInfoSchema),
    removed: z.array(z.string()),
    changed: z.array(deviceInfoSchema),
  }),
  'job.assign': z.object({
    run_id: z.uuid(),
    device_udid: z.string(),
    build: z.object({
      build_id: z.uuid(),
      package: z.string(),
      download_url: z.url(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
    items: z
      .array(
        z.object({
          run_item_id: z.uuid(),
          test_case_id: z.uuid(),
          commit: z.string().regex(/^[0-9a-f]{7,64}$/),
          yaml: z.string(),
        }),
      )
      .min(1),
    popups_yaml: z.string(),
    secrets: z.record(z.string(), z.string()),
    limits: z.object({
      run_timeout_ms: z.number().int().positive(),
      stable_timeout_ms: z.number().int().positive(),
    }),
  }),
  'job.ack': z.object({ run_id: z.uuid() }),
  'job.reject': z.object({ run_id: z.uuid(), reason: z.string() }),
  'item.result': z.object({
    run_id: z.uuid(),
    run_item_id: z.uuid(),
    status: itemStatus,
    failure_code: failureCodeSchema.optional(),
    failed_step_id: z.string().optional(),
    started_at: z.iso.datetime(),
    finished_at: z.iso.datetime(),
  }),
  'step.result': stepResultSchema.extend({ run_id: z.uuid(), run_item_id: z.uuid() }),
  'artifact.request_upload': z.object({
    run_id: z.uuid(),
    run_item_id: z.uuid(),
    step_index: z.number().int().nonnegative(),
    step_id: stepIdSchema,
    files: z
      .array(
        z.object({
          name: z.enum(['screenshot.png', 'tree.json', 'device.log', 'result.json']),
          content_type: z.string(),
          size_bytes: z.number().int().nonnegative(),
        }),
      )
      .min(1),
  }),
  'artifact.upload_url': z.object({
    uploads: z.array(
      z.object({ name: z.string(), url: z.url(), key: z.string(), expires_at: z.iso.datetime() }),
    ),
  }),
  'job.done': z.object({
    run_id: z.uuid(),
    status: z.enum(['passed', 'failed', 'cancelled', 'error']),
    failure_code: failureCodeSchema.optional(),
    summary: z.object({
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
    }),
  }),
  'job.cancel': z.object({ run_id: z.uuid(), reason: z.string() }),
  error: z.object({ code: z.string(), message: z.string() }),
} as const

export type MessageType = keyof typeof payloadSchemas
export type Payload<T extends MessageType> = z.infer<(typeof payloadSchemas)[T]>

/** Messages that answer another message and therefore must carry `re` (D18). */
export const REPLY_TYPES: ReadonlySet<MessageType> = new Set([
  'agent.welcome',
  'job.ack',
  'job.reject',
  'artifact.upload_url',
])

/** Who may send each type: A = agent, S = server. */
export const MESSAGE_DIRECTION: Record<MessageType, 'A→S' | 'S→A' | 'both'> = {
  'agent.hello': 'A→S',
  'agent.welcome': 'S→A',
  'agent.heartbeat': 'A→S',
  'device.update': 'A→S',
  'job.assign': 'S→A',
  'job.ack': 'A→S',
  'job.reject': 'A→S',
  'item.result': 'A→S',
  'step.result': 'A→S',
  'artifact.request_upload': 'A→S',
  'artifact.upload_url': 'S→A',
  'job.done': 'A→S',
  'job.cancel': 'S→A',
  error: 'both',
}

export type Message = {
  [T in MessageType]: {
    v: typeof PROTOCOL_VERSION
    type: T
    id: string
    ts: number
    re?: string
    payload: Payload<T>
  }
}[MessageType]

export type ParseResult =
  | { ok: true; message: Message }
  | {
      ok: false
      code: 'too_large' | 'invalid_json' | 'invalid_message'
      message: string
      id?: string
    }

/** UTF-8 byte length without Node or DOM globals (this package runs in both). */
function utf8Length(text: string): number {
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

/** Parses and validates one raw WebSocket text frame. Never throws. */
export function parseMessage(raw: string): ParseResult {
  if (utf8Length(raw) > MAX_MESSAGE_BYTES) {
    return { ok: false, code: 'too_large', message: `message exceeds ${MAX_MESSAGE_BYTES} bytes` }
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, code: 'invalid_json', message: 'message is not valid JSON' }
  }
  const env = envelopeSchema.safeParse(json)
  if (!env.success) {
    const id = (json as { id?: unknown } | null)?.id
    return {
      ok: false,
      code: 'invalid_message',
      message: z.prettifyError(env.error),
      ...(typeof id === 'string' ? { id } : {}),
    }
  }
  const { type, id, re } = env.data
  if (!(type in payloadSchemas)) {
    return { ok: false, code: 'invalid_message', message: `unknown type "${type}"`, id }
  }
  const messageType = type as MessageType
  if (REPLY_TYPES.has(messageType) && !re) {
    return { ok: false, code: 'invalid_message', message: `"${type}" must carry "re"`, id }
  }
  const payload = payloadSchemas[messageType].safeParse(env.data.payload)
  if (!payload.success) {
    return { ok: false, code: 'invalid_message', message: z.prettifyError(payload.error), id }
  }
  return { ok: true, message: { ...env.data, type: messageType, payload: payload.data } as Message }
}
