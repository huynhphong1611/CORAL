#!/usr/bin/env node
// Phase 1 DoD check over the REST API (quickstart §3–§5, T055):
//   node scripts/phase1-e2e.mjs --apk ./mydemo.apk --testcase fixtures/testcases/mydemo-login.yaml --runs 5
//   node scripts/phase1-e2e.mjs --apk ./mydemo.apk --testcase fixtures/testcases/mydemo-camera-permission.yaml \
//     --runs 5 --expect-popup android_permission
//   node scripts/phase1-e2e.mjs --scan-secrets --run <run_id>
//   node scripts/phase1-e2e.mjs --scan-secrets --test-case <id> [--recording <id>]   (Recorder, T058)
// Logs in, creates (or reuses) project + app, uploads the build, saves the test case, waits for an
// idle device, then runs it N times one after another and checks every run: passed, < 60 s, and
// every step's screenshot + tree downloadable (and, with --expect-popup, that the popup guard
// handled that rule in the run, SC-003). --download <dir> keeps every step's artifacts as
// <dir>/<run_id>/<slug>/<index>-<step_id>/{screenshot.png,tree.json,device.log}.
// Exit code 0 only when every check passed.
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'

/** @typedef {{ id: string, name: string }} Project */
/** @typedef {{ id: string, package_or_bundle_id: string }} App */
/** @typedef {{ id: string, version: string }} Build */
/** @typedef {{ id: string, slug: string }} TestCaseRef */
/** @typedef {{ id: string, yaml: string, head_commit: string }} TestCaseDetail */
/** @typedef {{ id: string, udid: string, platform: string, status: string }} Device */
/**
 * @typedef {{ id: string, slug?: string, status: string, failure_code: string | null,
 *   failed_step_id: string | null }} RunItem
 */
/**
 * @typedef {{ id: string, status: string, started_at: string | null,
 *   finished_at: string | null, items: RunItem[] }} Run
 */
/**
 * @typedef {{ step_index: number, step_id: string, status: string,
 *   failure_code: string | null, message: string | null,
 *   popups_handled: { rule: string, button: string }[],
 *   artifacts: { screenshot_url: string | null, tree_url: string | null,
 *   log_url: string | null } }} Step
 */

if (existsSync('.env')) process.loadEnvFile('.env')

const { values: opts } = parseArgs({
  options: {
    server: { type: 'string', default: process.env.CORAL_SERVER_URL ?? 'http://localhost:3000' },
    email: { type: 'string', default: process.env.CORAL_SEED_EMAIL },
    password: { type: 'string', default: process.env.CORAL_SEED_PASSWORD },
    project: { type: 'string', default: 'phase1-e2e' },
    app: { type: 'string', default: 'com.saucelabs.mydemoapp.android' },
    apk: { type: 'string' },
    testcase: { type: 'string' },
    runs: { type: 'string', default: '1' },
    device: { type: 'string' },
    'max-run-sec': { type: 'string', default: '60' },
    'scan-secrets': { type: 'boolean', default: false },
    'expect-popup': { type: 'string' },
    download: { type: 'string' },
    run: { type: 'string' },
    'test-case': { type: 'string' },
    recording: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
})

const usage = `usage:
  node scripts/phase1-e2e.mjs --apk <file.apk> --testcase <file.yaml> [--runs 5] [--app <package>] [--device <udid>] [--scan-secrets]
      [--expect-popup <popup rule>] [--download <dir>]
  node scripts/phase1-e2e.mjs --scan-secrets --run <run_id>
  node scripts/phase1-e2e.mjs --scan-secrets [--test-case <id>] [--recording <id>]
login: --email/--password or CORAL_SEED_EMAIL/CORAL_SEED_PASSWORD; server: --server or CORAL_SERVER_URL`

/**
 * @param {number} code
 * @param {string} message
 * @returns {never}
 */
function fail(code, message) {
  console.error(`phase1-e2e: ${message}`)
  process.exit(code)
}

if (opts.help) {
  console.log(usage)
  process.exit(0)
}
if (!opts.email || !opts.password) fail(2, `missing login\n${usage}`)
if (!opts.run && !opts['test-case'] && !opts.recording && (!opts.apk || !opts.testcase)) {
  fail(2, `need --apk and --testcase (or --run)\n${usage}`)
}

const base = opts.server.replace(/\/$/, '')
let token = ''

/**
 * Calls the API; returns status and parsed JSON body without judging the status.
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<{ status: number, body: unknown, text: string }>}
 */
async function call(method, path, body) {
  /** @type {Record<string, string>} */
  const headers = { authorization: `Bearer ${token}` }
  /** @type {RequestInit} */
  const init = { method, headers }
  if (body instanceof FormData) init.body = body
  else if (body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const res = await fetch(`${base}${path}`, init)
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text }
}

/**
 * Like call(), but throws unless the status is 200/201.
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<unknown>}
 */
async function api(method, path, body) {
  const res = await call(method, path, body)
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`${method} ${path} → ${res.status} ${res.text.slice(0, 500)}`)
  }
  return res.body
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function login() {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-coral-client': 'cli' },
    body: JSON.stringify({ email: opts.email, password: opts.password }),
  })
  if (res.status !== 200) fail(2, `login failed: HTTP ${res.status}`)
  token = /** @type {{ access_token: string }} */ (await res.json()).access_token
}

/** @returns {Promise<{ project: Project, app: App }>} */
async function projectAndApp() {
  const created = await call('POST', '/projects', { name: opts.project })
  const project =
    created.status === 201
      ? /** @type {Project} */ (created.body)
      : /** @type {Project[]} */ (await api('GET', '/projects')).find(
          (p) => p.name === opts.project,
        )
  if (!project) throw new Error(`cannot create or find project ${opts.project}`)
  const appBody = { platform: 'android', package_or_bundle_id: opts.app, name: opts.app }
  const madeApp = await call('POST', `/projects/${project.id}/apps`, appBody)
  const app =
    madeApp.status === 201
      ? /** @type {App} */ (madeApp.body)
      : /** @type {App[]} */ (await api('GET', `/projects/${project.id}/apps`)).find(
          (a) => a.package_or_bundle_id === opts.app,
        )
  if (!app) throw new Error(`cannot create or find app ${opts.app}`)
  return { project, app }
}

/**
 * @param {App} app
 * @param {string} apkPath
 * @returns {Promise<Build>}
 */
async function uploadBuild(app, apkPath) {
  const form = new FormData()
  form.set('version', `e2e-${new Date().toISOString()}`)
  form.set('file', new Blob([readFileSync(apkPath)]), basename(apkPath))
  return /** @type {Build} */ (await api('POST', `/apps/${app.id}/builds`, form))
}

/**
 * Saves the YAML as a test case; when the slug exists, updates it if the YAML differs.
 * @param {Project} project
 * @param {string} yamlPath
 * @returns {Promise<TestCaseRef>}
 */
async function saveTestCase(project, yamlPath) {
  const yaml = readFileSync(yamlPath, 'utf8')
  const created = await call('POST', `/projects/${project.id}/testcases`, { yaml })
  if (created.status === 201) return /** @type {TestCaseRef} */ (created.body)
  if (created.status !== 409) throw new Error(`test case rejected: ${created.text}`)
  const slug = /^id:\s*(\S+)/m.exec(yaml)?.[1]
  const list = /** @type {TestCaseRef[]} */ (await api('GET', `/projects/${project.id}/testcases`))
  const existing = list.find((t) => t.slug === slug)
  if (!existing) throw new Error(`test case ${slug} exists but cannot be found`)
  const current = /** @type {TestCaseDetail} */ (await api('GET', `/testcases/${existing.id}`))
  if (current.yaml !== yaml) {
    await api('PUT', `/testcases/${existing.id}`, { yaml, base_commit: current.head_commit })
  }
  return existing
}

/** @returns {Promise<Device>} */
async function idleDevice() {
  const deadline = Date.now() + 120_000
  for (;;) {
    const devices = /** @type {Device[]} */ (await api('GET', '/devices'))
    const device = devices.find(
      (d) =>
        d.platform === 'android' && d.status === 'idle' && (!opts.device || d.udid === opts.device),
    )
    if (device) return device
    if (Date.now() > deadline) {
      throw new Error('no idle Android device after 120 s (is the agent running?)')
    }
    await sleep(1000)
  }
}

/**
 * Creates one run, waits for it to end and checks it (status, duration, artifacts).
 * @param {{ project_id: string, build_id: string, device_id: string, test_case_ids: string[] }} ids
 */
async function runOnce(ids) {
  const created = /** @type {{ id: string }} */ (await api('POST', '/runs', ids))
  const deadline = Date.now() + 10 * 60_000
  /** @type {Run} */
  let run
  do {
    await sleep(500)
    run = /** @type {Run} */ (await api('GET', `/runs/${created.id}`))
    if (Date.now() > deadline) throw new Error(`run ${created.id} still ${run.status} after 10 min`)
  } while (run.status === 'queued' || run.status === 'running')

  /** @type {string[]} */
  const problems = []
  if (run.status !== 'passed') {
    const item = run.items.find((i) => i.status !== 'passed')
    const detail = item ? ` (${item.slug}: ${item.failure_code} at ${item.failed_step_id})` : ''
    problems.push(`status ${run.status}${detail}`)
  }
  const seconds = (Date.parse(run.finished_at ?? '') - Date.parse(run.started_at ?? '')) / 1000
  if (!(seconds < Number(opts['max-run-sec']))) problems.push(`took ${seconds.toFixed(1)} s`)
  let stepCount = 0
  /** @type {{ step_id: string, rule: string, button: string }[]} */
  const popups = []
  for (const item of run.items) {
    const steps = /** @type {Step[]} */ (await api('GET', `/runs/${run.id}/items/${item.id}/steps`))
    if (opts.download) {
      // The item's outcome next to its steps, as `coral run` writes it: CI describes failed runs.
      const itemDir = join(opts.download, run.id, item.slug ?? item.id)
      const failed = steps.find((s) => s.status === 'failed')
      await mkdir(itemDir, { recursive: true })
      await writeFile(
        join(itemDir, 'result.json'),
        JSON.stringify({
          status: item.status,
          failure_code: item.failure_code,
          message: failed?.message ?? null,
        }),
      )
    }
    for (const step of steps) {
      stepCount += 1
      for (const p of step.popups_handled) popups.push({ step_id: step.step_id, ...p })
      const dir = opts.download
        ? join(opts.download, run.id, item.slug ?? item.id, `${step.step_index}-${step.step_id}`)
        : undefined
      /** @type {[string, string | null, boolean][]} file, URL, required */
      const files = [
        ['screenshot.png', step.artifacts.screenshot_url, true],
        ['tree.json', step.artifacts.tree_url, true],
        ['device.log', step.artifacts.log_url, false],
      ]
      for (const [file, url, required] of files) {
        if (!url && !required) continue
        const res = url ? await fetch(url) : undefined
        if (res?.status !== 200) {
          problems.push(`${step.step_id} ${file}: HTTP ${res?.status ?? 'no url'}`)
        } else if (dir) {
          await mkdir(dir, { recursive: true })
          await writeFile(join(dir, file), new Uint8Array(await res.arrayBuffer()))
        }
      }
    }
  }
  const wanted = opts['expect-popup']
  if (wanted && !popups.some((p) => p.rule === wanted)) {
    problems.push(`popup rule ${wanted} not handled`)
  }
  return { run, seconds, stepCount, popups, problems }
}

/** The CORAL_SECRET_* values to look for (4 characters or more, like the redactor). */
function secretValues() {
  return Object.entries(process.env)
    .filter(([k, v]) => k.startsWith('CORAL_SECRET_') && v !== undefined && v.length >= 4)
    .map(([name, value]) => ({ name, value: value ?? '' }))
}

/**
 * A document when it can be read (200), else undefined — a presigned URL, or an API path.
 * @param {string} url
 */
async function fetchText(url) {
  const res = url.startsWith('/')
    ? await fetch(`${base}${url}`, { headers: { authorization: `Bearer ${token}` } })
    : await fetch(url)
  return res.status === 200 ? res.text() : undefined
}

/**
 * Run and step JSON, every tree.json and device.log of a run.
 * @param {string} runId
 */
async function runTexts(runId) {
  const run = /** @type {Run} */ (await api('GET', `/runs/${runId}`))
  const texts = [JSON.stringify(run)]
  for (const item of run.items) {
    const steps = /** @type {Step[]} */ (await api('GET', `/runs/${runId}/items/${item.id}/steps`))
    texts.push(JSON.stringify(steps))
    for (const step of steps) {
      for (const url of [step.artifacts.tree_url, step.artifacts.log_url]) {
        const text = url ? await fetchText(url) : undefined
        if (text !== undefined) texts.push(text)
      }
    }
  }
  return texts
}

/**
 * A test case's YAML at head and the tree.json of every snapshot under snap/<slug>/ (T058).
 * @param {string} id
 */
async function testCaseTexts(id) {
  const detail = /** @type {TestCaseDetail} */ (await api('GET', `/testcases/${id}`))
  const snapshots = /** @type {{ step_id: string, tree_url: string }[]} */ (
    await api('GET', `/testcases/${id}/snapshots`)
  )
  const texts = [detail.yaml, JSON.stringify(snapshots)]
  for (const snapshot of snapshots) {
    const text = await fetchText(snapshot.tree_url)
    if (text !== undefined) texts.push(text)
  }
  return texts
}

/**
 * A recording as the API gives it (steps, suggestions) and the tree.json of each step still
 * stored (a saved recording's snapshots are gone from S3: they live in the repo) (T058).
 * @param {string} id
 */
async function recordingTexts(id) {
  const recording = /** @type {{ steps?: { urls: { tree: string } }[] }} */ (
    await api('GET', `/recordings/${id}`)
  )
  const texts = [JSON.stringify(recording)]
  for (const step of recording.steps ?? []) {
    const text = await fetchText(step.urls.tree)
    if (text !== undefined) texts.push(text)
  }
  return texts
}

/**
 * Counts CORAL_SECRET_* values in documents (SC-008).
 * @param {string[]} texts
 */
function countSecrets(texts) {
  const secrets = secretValues()
  const hits = secrets.map(({ name, value }) => ({
    name,
    count: texts.reduce((n, t) => n + t.split(value).length - 1, 0),
  }))
  return {
    hits,
    total: hits.reduce((n, h) => n + h.count, 0),
    files: texts.length,
    secrets: secrets.length,
  }
}

/** @param {string} runId */
const scanSecrets = async (runId) => countSecrets(await runTexts(runId))

await login()

if (opts.run || opts['test-case'] || opts.recording) {
  /** @type {string[]} */
  const texts = []
  /** @type {string[]} */
  const what = []
  if (opts.run) {
    texts.push(...(await runTexts(opts.run)))
    what.push(`run ${opts.run}`)
  }
  if (opts['test-case']) {
    texts.push(...(await testCaseTexts(opts['test-case'])))
    what.push(`test case ${opts['test-case']}`)
  }
  if (opts.recording) {
    texts.push(...(await recordingTexts(opts.recording)))
    what.push(`recording ${opts.recording}`)
  }
  const scan = countSecrets(texts)
  console.log(
    `scanned ${scan.files} documents of ${what.join(', ')} for ${scan.secrets} secrets: ${scan.total} hits`,
  )
  for (const h of scan.hits.filter((x) => x.count > 0)) console.log(`  ${h.name}: ${h.count}`)
  process.exit(scan.total === 0 ? 0 : 1)
}

const { project, app } = await projectAndApp()
const build = await uploadBuild(app, opts.apk ?? '')
const testCase = await saveTestCase(project, opts.testcase ?? '')
const device = await idleDevice()
console.log(
  `project ${project.name} · app ${app.package_or_bundle_id} · build ${build.version} · test case ${testCase.slug} · device ${device.udid}`,
)

const runs = Number(opts.runs)
let passed = 0
for (let i = 1; i <= runs; i++) {
  const result = await runOnce({
    project_id: project.id,
    build_id: build.id,
    device_id: device.id,
    test_case_ids: [testCase.id],
  })
  if (opts['scan-secrets']) {
    const scan = await scanSecrets(result.run.id)
    if (scan.total > 0) result.problems.push(`${scan.total} secret occurrences`)
  }
  const ok = result.problems.length === 0
  if (ok) passed += 1
  const why = ok ? '' : ` — ${result.problems.join('; ')}`
  const handled = result.popups.map((p) => `${p.step_id} ${p.rule} → ${p.button}`).join(', ')
  const popups = handled ? `, popups: ${handled}` : ''
  console.log(
    `run ${i}/${runs} ${result.run.id}: ${ok ? 'PASS' : 'FAIL'} ${result.seconds.toFixed(1)} s, ${result.stepCount} steps${popups}${why}`,
  )
}
console.log(`${passed}/${runs} passed`)
process.exit(passed === runs ? 0 : 1)
