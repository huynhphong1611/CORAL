import { describe, expect, it } from 'vitest'
import { newId } from '../ids'
import { deviceCommandSchema } from './device-command'
import { envelope } from './envelope'
import {
  MAX_UI_MESSAGE_BYTES,
  UI_MESSAGE_DIRECTION,
  UI_REPLY_TYPES,
  parseUiMessage,
  uiPayloadSchemas,
  type UiMessageType,
} from './ui'

const id = () => newId()
const device = {
  id: id(),
  agent_id: id(),
  platform: 'android',
  kind: 'emulator',
  model: 'sdk_gphone64_x86_64',
  os_version: '14',
  api_level: 34,
  udid: 'emulator-5554',
  status: 'idle',
  activity: { kind: 'idle' },
}
const recordingStep = {
  n: 1,
  step: { id: 's2', action: 'tap', target: [{ android_id: 'id/menuIV' }, { desc: 'View menu' }] },
  suggestions: [{ visible_text: 'Log In' }],
  warnings: ['no_expect_after_tap'],
  snapshot: {
    screen: 'k/screen.jpg',
    tree: 'k/tree.json',
    element: 'k/element.png',
    screen_width: 1080,
    screen_height: 2400,
  },
  recorded_at: '2026-09-29T10:00:00.000Z',
}

const stats = {
  steps: 12,
  refused: 1,
  screens: 4,
  new_screens: 2,
  transitions: 6,
  findings: 0,
  cost_usd: 0.31,
  tests_written: 0,
  tests_active: 0,
}
const explorationStep = {
  n: 7,
  segment: 1,
  screen: { id: 'catalog', name: 'Danh sách sản phẩm', fingerprint: '9f2c4e71a0b3d5e8' },
  decision: { action: 'tap', element: 2, reason: 'Open the menu, not tried yet' },
  status: 'done',
  refusal: null,
  step: { id: 's7', action: 'tap', target: [{ android_id: 'id/menuIV' }] },
  flags: [],
  brain_call_id: id(),
  screenshot_url: 'http://localhost:9000/b/t/explorations/e/7/screen.jpg?X-Amz-Signature=s',
  cost_usd: 0.004,
  created_at: '2026-10-01T10:00:00.000Z',
}
const importStats = { total: 10, done: 3, active: 2, draft: 1, not_processed: 0, cost_usd: 1.2 }

/** One valid payload per type. */
const valid: { [T in UiMessageType]: unknown } = {
  'ui.auth': { access_token: 'eyJhbGciOi.x.y' },
  'ui.ready': { user_id: id(), tenant_id: id(), role: 'member' },
  'run.watch': { run_id: id() },
  'run.unwatch': { run_id: id() },
  'run.updated': { run_id: id(), status: 'running', items: [{ id: id(), status: 'running' }] },
  'run.step': {
    run_id: id(),
    run_item_id: id(),
    step_index: 0,
    step_id: 's1',
    status: 'passed',
    degraded: false,
    duration_ms: 1200,
  },
  'devices.updated': { devices: [device] },
  'stream.subscribe': { device_id: id() },
  'stream.unsubscribe': { device_id: id() },
  'stream.status': { device_id: id(), state: 'stalled', reason: 'no frame for 5 s' },
  'live.command': { live_session_id: id(), command: { kind: 'tap', x: 540, y: 1200 } },
  'live.result': { ok: true, command_id: id(), duration_ms: 310 },
  'recording.step': { recording_id: id(), step: recordingStep },
  'live.ended': { live_session_id: id(), reason: 'idle_timeout' },
  'live.inspect': { recording_id: id(), x: 10, y: 20 },
  'live.inspected': {
    element: {
      ref: '0.1',
      platform_id: 'com.x:id/title',
      text: 'Products',
      desc: '',
      class: 'android.widget.TextView',
      bounds: { x: 0, y: 0, w: 10, h: 10 },
      clickable: false,
      enabled: true,
      visible: true,
      package_or_bundle: 'com.x',
      children: [],
    },
    locators: [{ android_id: 'id/title' }, { text: 'Products' }],
    text: 'Products',
  },
  'exploration.watch': { exploration_id: id() },
  'exploration.unwatch': { exploration_id: id() },
  'exploration.updated': {
    exploration_id: id(),
    status: 'running',
    stats,
    current: { n: 7, screen_name: 'Danh sách sản phẩm', action_summary: 'tap "View menu"' },
  },
  'exploration.step': { exploration_id: id(), step: explorationStep },
  'exploration.screen': {
    exploration_id: id(),
    screen: {
      id: 'catalog',
      name: 'Danh sách sản phẩm',
      fingerprint: '9f2c4e71a0b3d5e8',
      is_new: true,
    },
  },
  'import.watch': { import_job_id: id() },
  'import.unwatch': { import_job_id: id() },
  'import.updated': {
    import_job_id: id(),
    status: 'running',
    stats: importStats,
    item: { n: 3, status: 'draft', reason: 'needs_human' },
  },
  error: { code: 'forbidden', message: 'viewer' },
}

const raw = (type: string, payload: unknown, re?: string) =>
  JSON.stringify(envelope(type, payload, re))

describe('WS /ws/ui protocol (contracts/ui-ws.md)', () => {
  it('has a direction for every type and accepts a valid payload of each', () => {
    expect(Object.keys(UI_MESSAGE_DIRECTION).sort()).toEqual(Object.keys(uiPayloadSchemas).sort())
    for (const type of Object.keys(uiPayloadSchemas) as UiMessageType[]) {
      const re = UI_REPLY_TYPES.has(type) ? id() : undefined
      const parsed = parseUiMessage(raw(type, valid[type], re))
      expect(parsed.ok, `${type}: ${parsed.ok ? '' : parsed.message}`).toBe(true)
    }
  })

  it('rejects an empty payload for every type that has fields', () => {
    for (const type of Object.keys(uiPayloadSchemas) as UiMessageType[]) {
      const re = UI_REPLY_TYPES.has(type) ? id() : undefined
      expect(parseUiMessage(raw(type, {}, re)).ok, type).toBe(false)
    }
  })

  it('requires re on replies', () => {
    for (const type of UI_REPLY_TYPES) {
      const parsed = parseUiMessage(raw(type, valid[type]))
      expect(!parsed.ok && parsed.message).toContain('must carry "re"')
    }
  })

  it('rejects unknown types, agent-only types and oversized messages', () => {
    expect(parseUiMessage(raw('job.assign', {})).ok).toBe(false)
    expect(parseUiMessage(raw('nope', {})).ok).toBe(false)
    const big = raw('ui.auth', { access_token: 'x'.repeat(MAX_UI_MESSAGE_BYTES) })
    expect(parseUiMessage(big)).toMatchObject({ ok: false, code: 'too_large' })
    expect(parseUiMessage('{not json')).toMatchObject({ ok: false, code: 'invalid_json' })
  })

  it('ties live commands and inspections to exactly one session or recording', () => {
    const command = { kind: 'back' }
    expect(parseUiMessage(raw('live.command', { command })).ok).toBe(false)
    expect(
      parseUiMessage(raw('live.command', { live_session_id: id(), recording_id: id(), command }))
        .ok,
    ).toBe(false)
    // record: true only while recording.
    expect(
      parseUiMessage(raw('live.command', { live_session_id: id(), command, record: true })).ok,
    ).toBe(false)
    expect(
      parseUiMessage(raw('live.command', { recording_id: id(), command, record: true })).ok,
    ).toBe(true)
    expect(parseUiMessage(raw('live.inspect', { x: 1, y: 2 })).ok).toBe(false)
  })

  it('records either a step or the popup rule that handled the tap (FR-015)', () => {
    const recording_id = id()
    expect(
      parseUiMessage(raw('recording.step', { recording_id, popup_rule: 'android_permission' })).ok,
    ).toBe(true)
    expect(parseUiMessage(raw('recording.step', { recording_id })).ok).toBe(false)
    expect(
      parseUiMessage(raw('recording.step', { recording_id, step: recordingStep, popup_rule: 'x' }))
        .ok,
    ).toBe(false)
    // A secret hint names the secret, never its value.
    expect(
      parseUiMessage(
        raw('recording.step', {
          recording_id,
          step: recordingStep,
          secret_hint: { name: 'TEST_PASSWORD' },
        }),
      ).ok,
    ).toBe(true)
    expect(
      parseUiMessage(
        raw('recording.step', {
          recording_id,
          step: recordingStep,
          secret_hint: { name: 'not a name!' },
        }),
      ).ok,
    ).toBe(false)
  })
})

describe('DeviceCommand (FR-008, FR-009)', () => {
  it('accepts the closed list of commands in device pixels', () => {
    for (const command of [
      { kind: 'tap', x: 0, y: 2399 },
      { kind: 'long_press', x: 1, y: 2, ms: 800 },
      { kind: 'swipe', from: { x: 540, y: 1800 }, to: { x: 540, y: 600 }, ms: 300 },
      { kind: 'type', text: 'Nguyễn Văn Ánh' },
      { kind: 'type', secret: 'TEST_PASSWORD' },
      { kind: 'back' },
      { kind: 'home' },
      { kind: 'hide_keyboard' },
      { kind: 'restart_app' },
    ]) {
      expect(deviceCommandSchema.safeParse(command).success, JSON.stringify(command)).toBe(true)
    }
  })

  it('rejects anything else', () => {
    for (const command of [
      { kind: 'shell', cmd: 'reboot' },
      { kind: 'tap', x: -1, y: 0 },
      { kind: 'tap', x: 1.5, y: 0 },
      { kind: 'tap', x: 1, y: 2, extra: true },
      { kind: 'type' },
      { kind: 'type', text: 'a', secret: 'B' },
      { kind: 'type', text: '' },
      { kind: 'restart_app', package: 'com.other' },
    ]) {
      expect(deviceCommandSchema.safeParse(command).success, JSON.stringify(command)).toBe(false)
    }
  })
})

describe('Phase 3 messages (contracts/ui-ws-phase3.md)', () => {
  it('reports why an exploration stopped with values of the data model', () => {
    const exploration_id = id()
    const updated = (extra: object) =>
      parseUiMessage(
        raw('exploration.updated', { exploration_id, status: 'done', stats, ...extra }),
      )
    expect(updated({ stop_reason: 'goal_not_reached' }).ok).toBe(true)
    expect(updated({ stop_reason: 'tired' }).ok).toBe(false)
    expect(updated({ status: 'paused' }).ok).toBe(false)
    expect(updated({ stats: { ...stats, cost_usd: -1 } }).ok).toBe(false)
  })

  it('sends trace steps the system took on its own and refused decisions', () => {
    const exploration_id = id()
    const step = (extra: object) =>
      parseUiMessage(
        raw('exploration.step', { exploration_id, step: { ...explorationStep, ...extra } }),
      )
    expect(step({ status: 'popup', decision: null, step: null, brain_call_id: null }).ok).toBe(true)
    expect(
      step({ status: 'refused', refusal: 'never_tap', step: null, flags: ['never_tap'] }).ok,
    ).toBe(true)
    expect(step({ refusal: 'rude' }).ok).toBe(false)
    expect(step({ flags: ['unknown_flag'] }).ok).toBe(false)
    // The AI's decision is checked against the same schema as its answer.
    expect(
      step({ decision: { action: 'type', element: 1, text: 'a', secret: 'B', reason: '' } }).ok,
    ).toBe(false)
    // A screen not named yet has no id nor name, but always a fingerprint.
    expect(step({ screen: { id: null, name: null, fingerprint: '9f2c4e71a0b3d5e8' } }).ok).toBe(
      true,
    )
    expect(step({ screen: { id: null, name: null, fingerprint: 'nope' } }).ok).toBe(false)
  })

  it('reports import progress with the reason of a draft item', () => {
    const import_job_id = id()
    const updated = (item: object) =>
      parseUiMessage(
        raw('import.updated', { import_job_id, status: 'running', stats: importStats, item }),
      )
    expect(updated({ n: 1, status: 'active' }).ok).toBe(true)
    expect(updated({ n: 1, status: 'draft', reason: 'app_mismatch' }).ok).toBe(true)
    expect(updated({ n: 1, status: 'draft', reason: 'bored' }).ok).toBe(false)
    expect(updated({ n: 0, status: 'active' }).ok).toBe(false)
  })

  it('shows a device busy with an exploration (devices.updated)', () => {
    const activity = {
      kind: 'exploration',
      exploration_id: id(),
      by: { user_id: id(), name: 'Huynh' },
    }
    expect(parseUiMessage(raw('devices.updated', { devices: [{ ...device, activity }] })).ok).toBe(
      true,
    )
  })
})
