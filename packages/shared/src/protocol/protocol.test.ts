import { describe, expect, it } from 'vitest'
import { newId } from '../ids'
import { MAX_MESSAGE_BYTES, envelope } from './envelope'
import { parseMessage, payloadSchemas, type MessageType } from './messages'

const runId = newId()
const itemId = newId()
const device = {
  udid: 'emulator-5554',
  platform: 'android',
  kind: 'emulator',
  model: 'sdk_gphone64_x86_64',
  os_version: '14',
  api_level: 34,
  status: 'idle',
} as const

/** One valid payload per message type (contracts/ws-protocol.md). */
const valid: { [T in MessageType]: unknown } = {
  'agent.hello': {
    agent_version: '0.1.0',
    os: 'linux',
    arch: 'x64',
    capabilities: { platforms: ['android'], u2_jar: '0.4.0' },
    devices: [device],
  },
  'agent.welcome': { agent_id: newId(), heartbeat_ms: 15000 },
  'agent.heartbeat': { devices: [{ udid: 'emulator-5554', status: 'busy' }] },
  'device.update': { added: [device], removed: ['emulator-5556'], changed: [] },
  'job.assign': {
    run_id: runId,
    device_udid: 'emulator-5554',
    build: {
      build_id: newId(),
      package: 'com.saucelabs.mydemoapp.android',
      download_url: 'http://localhost:9000/coral-artifacts/t/builds/b.apk?X-Amz-Signature=x',
      sha256: 'a'.repeat(64),
    },
    items: [{ run_item_id: itemId, test_case_id: newId(), commit: 'abc1234', yaml: 'schema: x' }],
    popups_yaml: 'schema: coral/popups@1',
    secrets: { TEST_USER: 'bob@example.com' },
    limits: { run_timeout_ms: 1_800_000, stable_timeout_ms: 3000 },
  },
  'job.ack': { run_id: runId },
  'job.reject': { run_id: runId, reason: 'device busy' },
  'item.result': {
    run_id: runId,
    run_item_id: itemId,
    status: 'failed',
    failure_code: 'TARGET_NOT_FOUND',
    failed_step_id: 's3',
    started_at: '2026-09-28T10:00:00.000Z',
    finished_at: '2026-09-28T10:00:12.000Z',
  },
  'step.result': {
    run_id: runId,
    run_item_id: itemId,
    step_index: 2,
    step_id: 's3',
    action: 'tap',
    status: 'passed',
    locator_used_index: 1,
    degraded: true,
    unstable: false,
    duration_ms: 812,
    popups_handled: [{ rule: 'android_permission', button: 'While using the app' }],
    artifacts: { screenshot: 't/runs/r/i/2-s3/screenshot.png', tree: 't/runs/r/i/2-s3/tree.json' },
  },
  'artifact.request_upload': {
    run_id: runId,
    run_item_id: itemId,
    step_index: 2,
    step_id: 's3',
    files: [{ name: 'screenshot.png', content_type: 'image/png', size_bytes: 120_000 }],
  },
  'artifact.upload_url': {
    uploads: [
      {
        name: 'screenshot.png',
        url: 'http://localhost:9000/coral-artifacts/x?X-Amz-Signature=y',
        key: 't/runs/r/i/2-s3/screenshot.png',
        expires_at: '2026-09-28T10:10:00.000Z',
      },
    ],
  },
  'job.done': { run_id: runId, status: 'passed', summary: { passed: 1, failed: 0, skipped: 0 } },
  'job.cancel': { run_id: runId, reason: 'cancelled by user' },
  'stream.start': { udid: 'emulator-5554', fps: 4 },
  'stream.stop': { udid: 'emulator-5554' },
  'device.command': {
    command_id: newId(),
    udid: 'emulator-5554',
    command: { kind: 'tap', x: 540, y: 1200 },
  },
  'device.command_result': { command_id: newId(), ok: true },
  error: { code: 'invalid_message', message: 'bad' },
}

const needsRe = new Set([
  'agent.welcome',
  'job.ack',
  'job.reject',
  'artifact.upload_url',
  'device.command_result',
])

describe('WS protocol (SPEC §15, D18, D33)', () => {
  it('covers every message type', () => {
    expect(Object.keys(valid).sort()).toEqual(Object.keys(payloadSchemas).sort())
  })

  for (const type of Object.keys(valid) as MessageType[]) {
    it(`accepts a valid ${type}`, () => {
      const re = needsRe.has(type) ? newId() : undefined
      const result = parseMessage(JSON.stringify(envelope(type, valid[type], re)))
      expect(result).toMatchObject({ ok: true, message: { type } })
    })

    it(`rejects a ${type} with an empty payload`, () => {
      const re = needsRe.has(type) ? newId() : undefined
      const result = parseMessage(JSON.stringify(envelope(type, {}, re)))
      expect(result.ok).toBe(false)
    })
  }

  it('rejects step ids that could escape an artifact key (T062)', () => {
    for (const type of ['step.result', 'artifact.request_upload'] as const) {
      for (const step_id of ['../../other-tenant', 'a/b', '']) {
        const payload = { ...(valid[type] as Record<string, unknown>), step_id }
        expect(parseMessage(JSON.stringify(envelope(type, payload)))).toMatchObject({
          ok: false,
          code: 'invalid_message',
        })
      }
    }
  })

  it('requires "re" on replies', () => {
    const result = parseMessage(JSON.stringify(envelope('job.ack', { run_id: runId })))
    expect(result).toMatchObject({ ok: false, code: 'invalid_message' })
  })

  it('returns the id of an invalid message so the reply can reference it', () => {
    const msg = envelope('job.ack', { run_id: 'nope' }, newId())
    expect(parseMessage(JSON.stringify(msg))).toMatchObject({ ok: false, id: msg.id })
  })

  it('rejects unknown types, bad JSON, wrong version and oversized frames', () => {
    expect(parseMessage(JSON.stringify(envelope('device.command', {})))).toMatchObject({
      ok: false,
      code: 'invalid_message',
    })
    expect(parseMessage('{')).toMatchObject({ ok: false, code: 'invalid_json' })
    expect(parseMessage(JSON.stringify({ ...envelope('error', valid.error), v: 2 }))).toMatchObject(
      {
        ok: false,
      },
    )
    expect(parseMessage('x'.repeat(MAX_MESSAGE_BYTES + 1))).toMatchObject({
      ok: false,
      code: 'too_large',
    })
  })
})

describe('Phase 2 agent messages (contracts/agent-ws-phase2.md)', () => {
  const parse = (type: MessageType, payload: unknown, re?: string) =>
    parseMessage(JSON.stringify(envelope(type, payload, re)))
  const command = (command: unknown) =>
    parse('device.command', { command_id: newId(), udid: 'emulator-5554', command })
  const upload = (keys: string[]) =>
    Object.fromEntries(keys.map((k) => [k, `http://localhost:9000/b/${k}?X-Amz-Signature=s`]))

  it('fills stream.start defaults and bounds its parameters', () => {
    const parsed = parse('stream.start', { udid: 'emulator-5554' })
    expect(parsed.ok && parsed.message.payload).toEqual({
      udid: 'emulator-5554',
      fps: 4,
      max_edge: 1280,
      quality: 60,
    })
    expect(parse('stream.start', { udid: 'e', fps: 10 }).ok).toBe(false)
    expect(parse('stream.start', { udid: 'e', quality: 95 }).ok).toBe(false)
  })

  it('sends typed text with the values to mask; restart_app names the package', () => {
    const typed = command({
      kind: 'type',
      text: 's3cret',
      redact: ['s3cret'],
      secret: 'TEST_PASSWORD',
    })
    expect(typed.ok).toBe(true)
    // The agent never receives a secret name without its value.
    expect(command({ kind: 'type', secret: 'TEST_PASSWORD' }).ok).toBe(false)
    expect(command({ kind: 'restart_app' }).ok).toBe(false)
    expect(command({ kind: 'restart_app', package: 'com.saucelabs.mydemoapp.android' }).ok).toBe(
      true,
    )
    expect(command({ kind: 'restart_app', package: 'rm -rf /' }).ok).toBe(false)
  })

  it('carries prepare, record and inspect with presigned uploads', () => {
    const pkg = 'com.saucelabs.mydemoapp.android'
    expect(
      command({
        kind: 'prepare',
        package: pkg,
        app_state: 'fresh',
        popups_yaml: 'schema: coral/popups@1',
        upload: upload(['screen', 'tree']),
      }).ok,
    ).toBe(true)
    expect(
      command({
        kind: 'record',
        action: { kind: 'tap', x: 1, y: 2 },
        package: pkg,
        popups_yaml: '',
        upload: upload(['screen', 'tree', 'element']),
      }).ok,
    ).toBe(true)
    expect(
      command({
        kind: 'record',
        action: { kind: 'shell' },
        package: pkg,
        popups_yaml: '',
        upload: upload(['screen', 'tree', 'element']),
      }).ok,
    ).toBe(false)
    expect(command({ kind: 'inspect', x: 3, y: 4 }).ok).toBe(true)
    expect(command({ kind: 'reboot' }).ok).toBe(false)
  })

  it('requires re on device.command_result', () => {
    const payload = {
      command_id: newId(),
      ok: false,
      error: { code: 'DRIVER_ERROR', message: 'x' },
    }
    expect(parse('device.command_result', payload).ok).toBe(false)
    expect(parse('device.command_result', payload, newId()).ok).toBe(true)
  })

  it('defaults job.assign item assets to none and keeps their paths inside the repo', () => {
    const assign = valid['job.assign'] as { items: Record<string, unknown>[] }
    const parsed = parse('job.assign', assign)
    expect(
      parsed.ok && parsed.message.type === 'job.assign' && parsed.message.payload.items[0]?.assets,
    ).toEqual([])
    const withAsset = (path: string) => ({
      ...assign,
      items: [
        {
          ...assign.items[0],
          assets: [{ path, sha256: 'b'.repeat(64), download_url: 'http://x/y' }],
        },
      ],
    })
    expect(parse('job.assign', withAsset('snap/login/s3/element.png')).ok).toBe(true)
    for (const bad of ['../secrets.png', '/etc/passwd', 'snap/../../x.png', 'snap\\x.png']) {
      expect(parse('job.assign', withAsset(bad)).ok, bad).toBe(false)
    }
  })
})
