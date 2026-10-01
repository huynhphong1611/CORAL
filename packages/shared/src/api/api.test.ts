import { describe, expect, it } from 'vitest'
import { newId } from '../ids'
import {
  DEFAULT_EXPLORATION_BUDGET,
  DEFAULT_MAX_TESTS,
  DEFAULT_MAX_TESTS_WITH_GOAL,
  EMPTY_EXPLORATION_STATS,
  PHASE3_ERROR_CODES,
  apiErrorSchema,
  brainCallSchema,
  brainsConfigViewSchema,
  controlSessionSchema,
  createExplorationSchema,
  explorationDetailSchema,
  explorationSchema,
  explorationStepsQuerySchema,
  importJobDetailSchema,
  importJobSchema,
  importPreviewSchema,
  listTestCasesQuerySchema,
  patchTestCaseSchema,
  skillDetailSchema,
  skillParamsSchema,
  startImportSchema,
  testCaseSummarySchema,
  updateAgentsMdSchema,
  updateMcpSchema,
  updateSkillSchema,
  usageQuerySchema,
  usageSchema,
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
      { kind: 'exploration', by, exploration_id: newId() },
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

describe('Phase 3 REST schemas (contracts/rest-api-phase3.md)', () => {
  const at = '2026-10-01T10:00:00.000Z'
  const by = { id: newId(), name: 'Huynh' }
  const stats = { ...EMPTY_EXPLORATION_STATS, steps: 12, cost_usd: 0.4 }

  it('has the new error codes', () => {
    expect(PHASE3_ERROR_CODES).toEqual([
      'brains_not_configured',
      'daily_limit_reached',
      'no_cases',
      'stdio_not_allowed',
      'too_many_explorations',
    ])
  })

  it('shows the brains config with its source and provider capabilities', () => {
    const view = {
      source: 'none',
      yaml: '',
      config: null,
      providers: [
        { id: 'claude', enabled: true, vision: true },
        { id: 'copilot', enabled: false, vision: false },
      ],
    }
    expect(brainsConfigViewSchema.safeParse(view).success).toBe(true)
    expect(brainsConfigViewSchema.safeParse({ ...view, source: 'file' }).success).toBe(false)
    expect(
      brainsConfigViewSchema.safeParse({
        ...view,
        source: 'tenant',
        config: {
          schema: 'coral/brains@1',
          roles: { explorer: { provider: 'gemini', model: 'm' } },
        },
      }).success,
    ).toBe(true)
  })

  it('groups AI usage by UTC day, role or provider', () => {
    expect(usageQuerySchema.parse({})).toEqual({ group: 'day' })
    expect(usageQuerySchema.safeParse({ group: 'model' }).success).toBe(false)
    expect(usageQuerySchema.safeParse({ from: '2026-10-02', to: '2026-10-01' }).success).toBe(false)
    expect(usageQuerySchema.safeParse({ from: '2026-10-01T00:00:00Z' }).success).toBe(false)
    expect(
      usageSchema.safeParse({
        rows: [{ key: 'gemini', calls: 40, tokens_in: 90_000, tokens_out: 4000, cost_usd: 0.12 }],
        total_cost_usd: 0.12,
        today: { cost_usd: 0.12, limit_usd: 20 },
      }).success,
    ).toBe(true)
  })

  it('returns one AI call with its content, or null once it expired', () => {
    const call = {
      id: newId(),
      role: 'explorer',
      provider: 'gemini',
      model: 'flash',
      attempt: 2,
      ok: false,
      error: 'rate_limited',
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
      latency_ms: 812,
      created_at: at,
      content: null,
      tool_calls: [],
    }
    expect(brainCallSchema.safeParse(call).success).toBe(true)
    expect(brainCallSchema.safeParse({ ...call, error: 'oops' }).success).toBe(false)
    expect(brainCallSchema.safeParse({ ...call, role: 'healer' }).success).toBe(false)
    const content = {
      role: 'explorer',
      provider: 'gemini',
      model: 'flash',
      attempt: 1,
      system: { stable_hash: 'ab12', volatile: 'Goal: none' },
      messages: [{ role: 'user', text: '#1 ImageView …', image: 'http://s3/x/ai.jpg?sig' }],
      rounds: [
        {
          tool_calls: [
            { name: 'otp__get_otp', args: { phone: '${secret:TEST_PHONE}' }, result: '123456' },
          ],
        },
      ],
      answer: '{"action":"back","reason":"done here"}',
      validation_errors: [],
      decision: { action: 'back', reason: 'done here' },
    }
    const tool = {
      id: newId(),
      mcp_server: 'otp',
      tool: 'send_sms',
      args_redacted: {},
      ok: false,
      blocked: true,
      error: 'side_effects_disabled',
      latency_ms: 0,
      created_at: at,
    }
    expect(brainCallSchema.safeParse({ ...call, content, tool_calls: [tool] }).success).toBe(true)
  })

  it('bounds the knowledge files and names skills like their folder', () => {
    const base_commit = 'abc1234'
    expect(updateAgentsMdSchema.safeParse({ content: '# Rules', base_commit }).success).toBe(true)
    expect(
      updateAgentsMdSchema.safeParse({ content: 'x'.repeat(64 * 1024 + 1), base_commit }).success,
    ).toBe(false)
    expect(skillParamsSchema.safeParse({ id: newId(), name: 'login-demo-account' }).success).toBe(
      true,
    )
    expect(skillParamsSchema.safeParse({ id: newId(), name: '../etc' }).success).toBe(false)
    expect(updateSkillSchema.safeParse({ skill_md: '', base_commit }).success).toBe(false)
    expect(
      skillDetailSchema.safeParse({
        name: 'login-demo-account',
        skill_md: '---\nname: login-demo-account\n---',
        rules_yaml: null,
        head_commit: base_commit,
      }).success,
    ).toBe(true)
    expect(updateMcpSchema.safeParse({ yaml: 'schema: coral/mcp@1', base_commit }).success).toBe(
      true,
    )
  })

  it('starts an exploration with an optional goal, partial budget and test count', () => {
    const ids = { project_id: newId(), app_id: newId(), build_id: newId(), device_id: newId() }
    expect(createExplorationSchema.parse(ids)).toEqual(ids)
    expect(
      createExplorationSchema.parse({
        ...ids,
        goal: '  Thêm vào giỏ  ',
        budget: { max_steps: 10 },
      }),
    ).toMatchObject({ goal: 'Thêm vào giỏ', budget: { max_steps: 10 } })
    expect(createExplorationSchema.safeParse({ ...ids, goal: '   ' }).success).toBe(false)
    expect(createExplorationSchema.safeParse({ ...ids, max_tests: 21 }).success).toBe(false)
    expect(createExplorationSchema.safeParse({ ...ids, budget: { max_cost_usd: 0 } }).success).toBe(
      false,
    )
    expect(DEFAULT_EXPLORATION_BUDGET).toEqual({ max_steps: 60, max_depth: 8, max_minutes: 20 })
    expect([DEFAULT_MAX_TESTS, DEFAULT_MAX_TESTS_WITH_GOAL]).toEqual([5, 1])
  })

  it('returns an exploration with its app map, test cases and findings', () => {
    const exploration = {
      id: newId(),
      project_id: newId(),
      app_id: newId(),
      build_id: newId(),
      device_id: newId(),
      kind: 'explore',
      goal: null,
      budget: { max_steps: 60, max_depth: 8, max_minutes: 20, max_cost_usd: 3 },
      max_tests: 5,
      status: 'done',
      stop_reason: 'max_steps',
      stats,
      created_by: by,
      created_at: at,
      started_at: at,
      finished_at: at,
    }
    expect(explorationSchema.safeParse(exploration).success).toBe(true)
    expect(explorationSchema.safeParse({ ...exploration, kind: 'roam' }).success).toBe(false)
    const detail = {
      ...exploration,
      appmap: {
        screens: [
          {
            id: 'catalog',
            name: 'Danh sách sản phẩm',
            fingerprint: '9f2c4e71a0b3d5e8',
            is_new: true,
            screenshot_url: null,
          },
        ],
        transitions: [
          {
            from: 'catalog',
            to: 'menu',
            action: { action: 'tap', target: [{ desc: 'View menu' }] },
          },
        ],
      },
      test_cases: [
        {
          id: newId(),
          slug: 'open-menu',
          status: 'draft',
          draft_reason: 'needs_human',
          flags: ['needs_review_never_tap'],
          validation: null,
        },
      ],
      findings: [
        {
          id: newId(),
          step_n: 4,
          kind: 'crashed',
          log_excerpt: 'FATAL EXCEPTION',
          screenshot_url: null,
          created_at: at,
        },
      ],
      writer_report: {
        flows: 2,
        skipped: [
          {
            slug: 'open-menu',
            name: 'Open the menu',
            intent: 'Open the menu from the catalog',
            reason: 'duplicate',
            duplicate_of: 'menu',
          },
        ],
        error: null,
      },
    }
    expect(explorationDetailSchema.safeParse(detail).success).toBe(true)
    expect(
      explorationDetailSchema.safeParse({
        ...detail,
        writer_report: { flows: 0, skipped: [], error: 'tired' },
      }).success,
    ).toBe(false)
    // A transition is a step without id or expectation.
    const withId = {
      ...detail,
      appmap: {
        ...detail.appmap,
        transitions: [{ from: 'catalog', to: 'menu', action: { id: 's1', action: 'back' } }],
      },
    }
    expect(explorationDetailSchema.safeParse(withId).success).toBe(false)
    expect(explorationStepsQuerySchema.parse({ after: '20' })).toEqual({ after: 20, limit: 50 })
    expect(explorationStepsQuerySchema.safeParse({ limit: '500' }).success).toBe(false)
  })

  it('previews, starts and reports an import of manual test cases', () => {
    const manual = {
      schema: 'coral/manualcase@1',
      id: 'TC-1',
      title: 'Login with valid account',
      steps: [{ action: 'Open the app' }],
      source: { file: 'cases.csv', row: 2 },
    }
    const preview = {
      import_job_id: newId(),
      format: 'csv',
      file_name: 'cases.csv',
      columns: [
        { index: 0, header: 'Title' },
        { index: 1, header: 'Steps' },
      ],
      mapping: { title: 0, steps: [1], expected: [], header_row: 0 },
      cases: [manual],
      errors: [{ row: 5, message: 'no steps' }],
    }
    expect(importPreviewSchema.safeParse(preview).success).toBe(true)
    expect(importPreviewSchema.safeParse({ ...preview, format: 'docx' }).success).toBe(false)
    expect(
      startImportSchema.safeParse({
        app_id: newId(),
        build_id: newId(),
        device_id: newId(),
        budget: { max_cost_usd: 5 },
      }).success,
    ).toBe(true)
    const job = {
      id: newId(),
      project_id: newId(),
      app_id: null,
      build_id: null,
      device_id: null,
      source_format: 'csv',
      file_name: 'cases.csv',
      status: 'preview',
      budget: null,
      stats: { total: 10, done: 0, active: 0, draft: 0, not_processed: 0, cost_usd: 0 },
      manual_commit: null,
      created_by: by,
      created_at: at,
      started_at: null,
      finished_at: null,
    }
    expect(importJobSchema.safeParse(job).success).toBe(true)
    const report = {
      total: 10,
      active: 8,
      draft: { needs_human: 1, ambiguous: 0, app_mismatch: 1, validation_failed: 0, duplicate: 0 },
      not_processed: 0,
      cost_usd: 4.1,
      items: [{ n: 1, title: 'Login with valid account', status: 'active', test_case_id: newId() }],
    }
    const detail = {
      ...job,
      status: 'done',
      items: [
        {
          n: 2,
          title: 'Pay with saved card',
          status: 'draft',
          reason: 'needs_human',
          evidence: { step_n: 7, message: 'payment needs a real card' },
          exploration_id: newId(),
          test_case_id: newId(),
        },
      ],
      report,
    }
    expect(importJobDetailSchema.safeParse(detail).success).toBe(true)
    const draft = { ...report.draft, duplicate: undefined }
    expect(
      importJobDetailSchema.safeParse({ ...detail, report: { ...report, draft } }).success,
    ).toBe(false)
  })

  it('adds the source, draft reason, flags and validation to test cases', () => {
    const summary = {
      id: newId(),
      slug: 'open-menu',
      intent: 'Open the menu',
      tags: [],
      platforms: ['android'],
      status: 'draft',
      head_commit: 'abc1234',
      source: 'ai_explore',
      source_ref: newId(),
      draft_reason: 'validation_failed',
      flags: [],
      validation: {
        commit: 'abc1234',
        runs: [
          { run_id: newId(), status: 'passed' },
          { run_id: newId(), status: 'failed', failure_code: 'TARGET_NOT_FOUND', step_id: 's4' },
        ],
      },
      updated_at: at,
    }
    expect(testCaseSummarySchema.safeParse(summary).success).toBe(true)
    expect(testCaseSummarySchema.safeParse({ ...summary, draft_reason: 'lazy' }).success).toBe(
      false,
    )
    expect(testCaseSummarySchema.safeParse({ ...summary, flags: ['shiny'] }).success).toBe(false)
    expect(listTestCasesQuerySchema.parse({ source: 'ai_prompt' })).toEqual({ source: 'ai_prompt' })
    expect(patchTestCaseSchema.safeParse({ status: 'deleted' }).success).toBe(false)
  })
})
