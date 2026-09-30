import { newId, type api } from '@coral/shared'

/** Sample API objects for component tests (shapes of contracts/rest-api*.md). */

const at = '2026-09-29T08:00:00.000Z'

export const project = (name = 'Shop', over: Partial<api.Project> = {}): api.Project => ({
  id: newId(),
  name,
  created_at: at,
  ...over,
})

export const testCase = (
  slug: string,
  over: Partial<api.TestCaseSummary> = {},
): api.TestCaseSummary => ({
  id: newId(),
  slug,
  intent: `Intent of ${slug}`,
  tags: [],
  platforms: ['android'],
  status: 'active',
  head_commit: 'a'.repeat(40),
  source: 'manual',
  updated_at: at,
  ...over,
})

export const app = (projectId: string, over: Partial<api.App> = {}): api.App => ({
  id: newId(),
  project_id: projectId,
  platform: 'android',
  package_or_bundle_id: 'com.example.shop',
  name: 'Shop',
  created_at: at,
  ...over,
})

export const build = (appId: string, version = '1.0.0'): api.Build => ({
  id: newId(),
  app_id: appId,
  version,
  checksum_sha256: 'b'.repeat(64),
  size_bytes: 12_582_912,
  created_at: at,
})

export const device = (
  model: string,
  activity: api.DeviceActivity = { kind: 'idle' },
  over: Partial<api.DeviceView> = {},
): api.DeviceView => ({
  id: newId(),
  agent_id: newId(),
  platform: 'android',
  kind: 'emulator',
  model,
  os_version: '14',
  api_level: 34,
  udid: `emulator-${5554 + Math.floor(Math.random() * 100) * 2}`,
  status: activity.kind === 'offline' ? 'offline' : activity.kind === 'idle' ? 'idle' : 'leased',
  activity,
  ...over,
})

export const run = (over: Partial<api.Run> = {}, slugs = ['login']): api.Run => ({
  id: newId(),
  project_id: newId(),
  build_id: newId(),
  device_id: newId(),
  status: 'passed',
  failure_code: null,
  queued_at: at,
  started_at: '2026-09-29T08:00:01.000Z',
  finished_at: '2026-09-29T08:00:13.500Z',
  items: slugs.map((slug, position) => ({
    id: newId(),
    test_case_id: newId(),
    slug,
    commit: 'c'.repeat(40),
    position,
    status: 'passed',
    failure_code: null,
    failed_step_id: null,
  })),
  ...over,
})

export const step = (index: number, over: Partial<api.RunStep> = {}): api.RunStep => ({
  step_index: index,
  step_id: `s${index + 1}`,
  action: 'tap',
  status: 'passed',
  locator_used_index: 0,
  degraded: false,
  unstable: false,
  duration_ms: 850,
  failure_code: null,
  message: null,
  popups_handled: [],
  artifacts: {
    screenshot_url: `https://s3.test/steps/${index}/screenshot.png`,
    tree_url: `https://s3.test/steps/${index}/tree.json`,
    log_url: `https://s3.test/steps/${index}/device.log`,
  },
  ...over,
})

type RecordedStep = NonNullable<api.Recording['steps']>[number]

/** A recorded step with its snapshot URLs (`GET /recordings/:id`). */
export const recordedStep = (
  n: number,
  step: RecordedStep['step'],
  over: Partial<RecordedStep> = {},
): RecordedStep => ({
  n,
  step,
  suggestions: [],
  warnings: [],
  snapshot: {
    screen: `t/recordings/r/${n}/screen.jpg`,
    tree: `t/recordings/r/${n}/tree.json`,
    screen_width: 1080,
    screen_height: 2400,
  },
  recorded_at: at,
  urls: {
    screen: `https://s3.test/r/${n}/screen.jpg`,
    tree: `https://s3.test/r/${n}/tree.json`,
  },
  ...over,
})

export const recording = (
  projectId: string,
  deviceId: string,
  over: Partial<api.Recording> = {},
): api.Recording => ({
  id: newId(),
  project_id: projectId,
  app_id: newId(),
  build_id: newId(),
  device_id: deviceId,
  status: 'recording',
  intent: '',
  slug: 'recording-1a2b3c4d',
  created_by: { id: newId(), name: 'Huynh' },
  created_at: at,
  updated_at: at,
  expires_at: '2026-10-06T08:00:00.000Z',
  test_case_id: null,
  ...over,
})
