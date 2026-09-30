import { describe, expect, it } from 'vitest'
import { newId } from '../ids'
import {
  apiErrorSchema,
  controlSessionSchema,
  createAppSchema,
  createRecordingSchema,
  deviceBusyErrorSchema,
  deviceViewSchema,
  patchRecordingSchema,
  recordingSchema,
  saveRecordingSchema,
  createRunSchema,
  createdAgentSchema,
  listRunsQuerySchema,
  readinessSchema,
  runSchema,
  sessionSchema,
  updateTestCaseSchema,
} from './index'

describe('REST API schemas (contracts/rest-api.md)', () => {
  it('accepts a login session and requires snake_case fields', () => {
    const session = {
      access_token: 'jwt',
      expires_in: 900,
      user: { id: newId(), email: 'huynh@example.com', name: 'Huynh' },
      tenant: { id: newId(), name: 'Coral', role: 'owner' },
    }
    expect(sessionSchema.parse(session)).toEqual(session)
    expect(
      sessionSchema.safeParse({ ...session, access_token: undefined, accessToken: 'x' }).success,
    ).toBe(false)
  })

  it('validates Android package names', () => {
    expect(
      createAppSchema.safeParse({
        platform: 'android',
        package_or_bundle_id: 'com.saucelabs.mydemoapp.android',
        name: 'My Demo App',
      }).success,
    ).toBe(true)
    expect(
      createAppSchema.safeParse({ platform: 'android', package_or_bundle_id: 'demo', name: 'x' })
        .success,
    ).toBe(false)
  })

  it('only accepts agent tokens in the coral_agt_ format', () => {
    expect(
      createdAgentSchema.safeParse({
        id: newId(),
        name: 'laptop',
        token: `coral_agt_${'x'.repeat(43)}`,
      }).success,
    ).toBe(true)
    expect(
      createdAgentSchema.safeParse({ id: newId(), name: 'laptop', token: 'secret' }).success,
    ).toBe(false)
  })

  it('requires base_commit when updating a test case', () => {
    expect(updateTestCaseSchema.safeParse({ yaml: 'x' }).success).toBe(false)
    expect(updateTestCaseSchema.safeParse({ yaml: 'x', base_commit: 'abc1234' }).success).toBe(true)
  })

  it('bounds a run to 1–50 test cases', () => {
    const base = { project_id: newId(), build_id: newId(), device_id: newId() }
    expect(createRunSchema.safeParse({ ...base, test_case_ids: [] }).success).toBe(false)
    expect(createRunSchema.safeParse({ ...base, test_case_ids: [newId()] }).success).toBe(true)
  })

  it('parses a run with items', () => {
    const run = {
      id: newId(),
      project_id: newId(),
      build_id: newId(),
      device_id: newId(),
      status: 'running',
      failure_code: null,
      queued_at: '2026-09-28T10:00:00.000Z',
      started_at: '2026-09-28T10:00:02.000+00:00',
      finished_at: null,
      items: [
        {
          id: newId(),
          test_case_id: newId(),
          commit: 'abc1234',
          position: 0,
          status: 'failed',
          failure_code: 'EXPECT_FAILED',
          failed_step_id: 's4',
        },
      ],
    }
    expect(runSchema.parse(run)).toEqual(run)
  })

  it('defaults and bounds the run list query', () => {
    expect(listRunsQuerySchema.parse({})).toEqual({ limit: 20 })
    expect(listRunsQuerySchema.safeParse({ limit: '500' }).success).toBe(false)
  })

  it('keeps readiness and errors minimal', () => {
    expect(readinessSchema.safeParse({ status: 'ok', postgres: 'up' }).data).toEqual({
      status: 'ok',
    })
    expect(
      apiErrorSchema.safeParse({
        error: {
          code: 'validation_failed',
          message: 'x',
          details: [{ path: 'intent', code: 'schema', message: 'm' }],
        },
      }).success,
    ).toBe(true)
  })
})

describe('Phase 2 REST schemas (contracts/rest-api-phase2.md)', () => {
  const device = {
    id: newId(),
    agent_id: newId(),
    platform: 'android',
    kind: 'emulator',
    model: 'sdk_gphone64_x86_64',
    os_version: '14',
    api_level: 34,
    udid: 'emulator-5554',
    status: 'leased',
  }

  it('describes what a device is doing and who holds it', () => {
    const by = { user_id: newId(), name: 'Huynh' }
    for (const activity of [
      { kind: 'idle' },
      { kind: 'run', run_id: newId(), since: '2026-09-29T10:00:00.000Z' },
      { kind: 'live', by },
      { kind: 'recording', by },
    ]) {
      expect(deviceViewSchema.safeParse({ ...device, activity }).success, activity.kind).toBe(true)
    }
    expect(deviceViewSchema.safeParse(device).success).toBe(false)
    expect(
      deviceBusyErrorSchema.safeParse({
        error: {
          code: 'device_busy',
          message: 'controlled by Huynh',
          activity: { kind: 'live', by },
        },
      }).success,
    ).toBe(true)
  })

  it('returns the control session with its holder and idle timeout', () => {
    expect(
      controlSessionSchema.safeParse({
        live_session_id: newId(),
        device_id: newId(),
        user: { id: newId(), name: 'Huynh' },
        started_at: '2026-09-29T10:00:00.000Z',
        expires_at: '2026-09-29T10:10:00.000Z',
        idle_timeout_ms: 600_000,
      }).success,
    ).toBe(true)
  })

  it('starts, edits and saves recordings', () => {
    const ids = { project_id: newId(), app_id: newId(), build_id: newId(), device_id: newId() }
    expect(createRecordingSchema.safeParse(ids).success).toBe(true)
    expect(createRecordingSchema.safeParse({ ...ids, device_id: 'emulator-5554' }).success).toBe(
      false,
    )
    expect(patchRecordingSchema.safeParse({}).success).toBe(false)
    expect(patchRecordingSchema.safeParse({ slug: 'Bad Slug' }).success).toBe(false)
    expect(
      patchRecordingSchema.safeParse({ intent: 'Đăng nhập', slug: 'recorded-login' }).success,
    ).toBe(true)
    // A step that is not a coral/testcase@1 step is refused.
    const step = {
      n: 1,
      step: { id: 's1', action: 'fly' },
      suggestions: [],
      warnings: [],
      snapshot: { screen: 'a', tree: 'b', screen_width: 1080, screen_height: 2400 },
      recorded_at: '2026-09-29T10:00:00.000Z',
    }
    expect(patchRecordingSchema.safeParse({ steps: [step] }).success).toBe(false)
    expect(
      patchRecordingSchema.safeParse({ steps: [{ ...step, step: { id: 's1', action: 'launch' } }] })
        .success,
    ).toBe(true)
    const save = { slug: 'recorded-login', intent: 'Đăng nhập', yaml: 'schema: coral/testcase@1' }
    expect(saveRecordingSchema.safeParse(save).success).toBe(true)
    expect(saveRecordingSchema.safeParse({ ...save, replace: true }).success).toBe(false)
    expect(
      saveRecordingSchema.safeParse({ ...save, replace: true, base_commit: 'abc1234' }).success,
    ).toBe(true)
  })

  it('lists recordings without steps', () => {
    const recording = {
      id: newId(),
      project_id: newId(),
      app_id: newId(),
      build_id: newId(),
      device_id: newId(),
      status: 'recording',
      intent: '',
      slug: 'recording-1',
      created_by: { id: newId(), name: 'Huynh' },
      created_at: '2026-09-29T10:00:00.000Z',
      updated_at: '2026-09-29T10:00:00.000Z',
      expires_at: '2026-10-06T10:00:00.000Z',
      test_case_id: null,
    }
    expect(recordingSchema.safeParse(recording).success).toBe(true)
    expect(recordingSchema.safeParse({ ...recording, status: 'paused' }).success).toBe(false)
  })

  it('filters runs by device and test case', () => {
    const device_id = newId()
    expect(listRunsQuerySchema.parse({ device_id })).toMatchObject({ device_id, limit: 20 })
    expect(listRunsQuerySchema.safeParse({ test_case_id: 'x' }).success).toBe(false)
  })
})
