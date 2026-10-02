import { z } from 'zod'
import { FAILURE_CODES } from '../failure-codes'
import { STEP_ID_PATTERN } from '../testcase/schema'
import { FINGERPRINT_PATTERN, SCREEN_ID_PATTERN } from '../appmap/schema'
import { elementNodeSchema, elementTreeSchema } from '../element'
import { expectConditionSchema, locatorSchema, stepSchema } from '../testcase/schema'
import { RECORDING_WARNINGS } from '../recording'
import { PLAIN_COMMAND_SCHEMAS, coordSchema, secretNameSchema } from './device-command'
import type { PROTOCOL_VERSION } from './envelope'
import { MAX_MESSAGE_BYTES } from './envelope'
import { parseEnvelope, type ParseFailure } from './parse'

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

const packageName = z.string().regex(/^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/, 'Android package name')
/** A path inside the project repo (research R12): relative, no `..`, no backslashes. */
const repoPath = z
  .string()
  .regex(/^(?!\/)(?!.*(^|\/)\.\.(\/|$))[^\\\0]+$/, 'relative path inside the project repo')

// ---- device commands on the agent channel (contracts/agent-ws-phase2.md) --------------------------

/**
 * A browser command as the agent receives it: `type` always carries the text — the server has
 * swapped a secret name for its value and lists the values to mask in `redact`; `secret` keeps the
 * name so a recorded step says `${secret:NAME}`. `restart_app` names the package under test (P6).
 */
const agentTypeSchema = z.strictObject({
  kind: z.literal('type'),
  text: z.string().min(1).max(10_000),
  redact: z.array(z.string()).default([]),
  secret: secretNameSchema.optional(),
})
const agentRestartSchema = z.strictObject({ kind: z.literal('restart_app'), package: packageName })
const agentActionSchema = z.discriminatedUnion('kind', [
  ...PLAIN_COMMAND_SCHEMAS,
  agentTypeSchema,
  agentRestartSchema,
])
export type AgentAction = z.infer<typeof agentActionSchema>
export { agentActionSchema }

const uploadUrls = { screen: z.url(), tree: z.url() }
/** Secret values the agent masks in what it uploads and logs (the snapshot's tree.json). */
const redact = { redact: z.array(z.string()).default([]) }

export const agentCommandSchema = z.discriminatedUnion('kind', [
  ...PLAIN_COMMAND_SCHEMAS,
  agentTypeSchema,
  agentRestartSchema,
  z.strictObject({
    kind: z.literal('prepare'),
    package: packageName,
    build: z
      .object({ download_url: z.url(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })
      .optional(),
    app_state: z.enum(['fresh', 'keep']),
    popups_yaml: z.string(),
    upload: z.object(uploadUrls),
    ...redact,
  }),
  z.strictObject({
    kind: z.literal('record'),
    action: agentActionSchema,
    package: packageName,
    popups_yaml: z.string(),
    upload: z.object({ ...uploadUrls, element: z.url() }),
    ...redact,
  }),
  z.strictObject({ kind: z.literal('inspect'), x: coordSchema, y: coordSchema, ...redact }),
  // The Explorer's look at the screen (contracts/agent-ws-phase3.md, research R7).
  z.strictObject({
    kind: z.literal('observe'),
    package: packageName,
    popups_yaml: z.string(),
    upload: z.object({ ...uploadUrls, ai: z.url() }),
    ...redact,
  }),
])
export type AgentCommand = z.infer<typeof agentCommandSchema>

const screenSize = {
  screen_width: z.number().int().positive(),
  screen_height: z.number().int().positive(),
}

/** Largest crash log excerpt an `observe` result carries (contracts/agent-ws-phase3.md). */
export const MAX_LOG_EXCERPT = 4096
/** Largest serialised tree in an `observe` result; the agent fails the command above it. */
export const MAX_OBSERVE_TREE_BYTES = 2 * 1024 * 1024

/** `device.command_result.result` per command kind; the server validates it knowing the kind. */
export const commandResultSchemas = {
  prepare: z.object({ ...screenSize }),
  record: z.object({
    // No step when a popup rule handled the tap (FR-015).
    step: stepSchema.optional(),
    suggestions: z.array(expectConditionSchema).max(3),
    warnings: z.array(z.enum(RECORDING_WARNINGS)),
    popup_rule: z.string().min(1).optional(),
    target_password: z.boolean().optional(),
    ...screenSize,
  }),
  inspect: z.object({
    element: elementNodeSchema,
    locators: z.array(locatorSchema),
    text: z.string(),
  }),
  observe: z.object({
    ...screenSize,
    package: z.string(),
    // From `dumpsys activity` when the platform tells; fingerprints use it (research R8).
    activity: z.string().min(1).optional(),
    app_running: z.boolean(),
    // Same detection as the runner's APP_CRASHED / APP_NOT_RESPONDING; secrets already masked.
    crash: z
      .object({
        kind: z.enum(['crashed', 'not_responding']),
        log_excerpt: z.string().max(MAX_LOG_EXCERPT),
      })
      .nullable(),
    popups_handled: z.array(z.string()),
    // Secrets masked; at most MAX_OBSERVE_TREE_BYTES serialised (bounded by the message size).
    tree: elementTreeSchema,
  }),
} as const
export type CommandResult<K extends keyof typeof commandResultSchemas> = z.infer<
  (typeof commandResultSchemas)[K]
>

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
          // Images the test case's `image` locators refer to (research R12); none before Phase 2.
          assets: z
            .array(
              z.object({
                path: repoPath,
                sha256: z.string().regex(/^[0-9a-f]{64}$/),
                download_url: z.url(),
              }),
            )
            .default([]),
          // Fingerprints of the app map screens the test case's `expect.screen` names (D24).
          screens: z
            .record(
              z.string().regex(SCREEN_ID_PATTERN, 'screen id'),
              z.string().regex(FINGERPRINT_PATTERN, '16 hex characters'),
            )
            .default({}),
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
  // Live view (research R4–R5); frames themselves are binary (frame.ts).
  'stream.start': z.object({
    udid: z.string().min(1),
    fps: z.number().int().min(2).max(5).default(4),
    max_edge: z.number().int().min(320).max(2560).default(1280),
    quality: z.number().int().min(30).max(90).default(60),
  }),
  'stream.stop': z.object({ udid: z.string().min(1) }),
  // Control, recording and inspection (research R7–R8).
  'device.command': z.object({
    command_id: z.uuid(),
    udid: z.string().min(1),
    command: agentCommandSchema,
  }),
  'device.command_result': z.object({
    command_id: z.uuid(),
    ok: z.boolean(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
    result: z.record(z.string(), z.unknown()).optional(),
  }),
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
  'device.command_result',
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
  'stream.start': 'S→A',
  'stream.stop': 'S→A',
  'device.command': 'S→A',
  'device.command_result': 'A→S',
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

export type ParseResult = { ok: true; message: Message } | ParseFailure

/** Parses and validates one raw WebSocket text frame from/to an agent. Never throws. */
export function parseMessage(raw: string): ParseResult {
  const parsed = parseEnvelope(raw, {
    schemas: payloadSchemas,
    replyTypes: REPLY_TYPES,
    maxBytes: MAX_MESSAGE_BYTES,
  })
  if (!parsed.ok) return parsed
  return {
    ok: true,
    message: { ...parsed.envelope, type: parsed.type, payload: parsed.payload } as Message,
  }
}
