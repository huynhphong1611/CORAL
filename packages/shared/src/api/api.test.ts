import { describe, expect, it } from 'vitest'
import { newId } from '../ids'
import {
  apiErrorSchema,
  createAppSchema,
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
