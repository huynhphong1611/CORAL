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
