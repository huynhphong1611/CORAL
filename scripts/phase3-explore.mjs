#!/usr/bin/env node
// Phase 3 Explorer check over the REST API (T036, quickstart §3):
//   node scripts/phase3-explore.mjs --apk ./mydemo.apk [--steps 25] [--never-tap 'Log Out'] [--min-screens 4]
//     [--min-active 0] [--app <package>] [--device <udid>] [--download <dir>]
// Logs in, creates (or reuses) project + app, uploads the build, adds the --never-tap labels to the
// project's popups.yaml, waits for an idle device and explores it with the AI the server is
// configured with (the `fake` brain in CI). Checks: the exploration ends without error, its app
// map has at least --min-screens screens of different fingerprints, every screen has the
// activity `observe` read, no recorded step touches a never_tap label, and at least --min-active
// of the test cases the Test writer made from it passed their two validation runs (US3; each is
// listed with its validation). --download keeps the
// app map pictures as <dir>/appmap/<nn>-<screen_id>.jpg and each step's screenshot as
// <dir>/trace/<nnn>-<status>.jpg (contact sheets), and the written YAML as
// <dir>/testcases/<slug>.yaml. Exit code 0 only when every check passed.
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'

/** @typedef {{ id: string, name: string }} Project */
/** @typedef {{ id: string, package_or_bundle_id: string }} App */
/** @typedef {{ id: string }} Build */
/** @typedef {{ id: string, udid: string, platform: string, status: string }} Device */
/**
 * @typedef {{ id: string, status: string, stop_reason: string | null,
 *   stats: { steps: number, screens: number, new_screens: number, transitions: number,
 *   refused: number, findings: number, cost_usd: number, tests_written: number,
 *   tests_active: number },
 *   appmap: { screens: { id: string, name: string, fingerprint: string, is_new: boolean,
 *   screenshot_url: string | null }[], transitions: unknown[] } }} Exploration
 */
/**
 * @typedef {{ n: number, status: string, refusal: string | null, flags: string[],
 *   step: unknown, screenshot_url: string | null, screen: { id: string | null } }} Step
 */
/** @typedef {{ id: string, fingerprint: string, activity?: string, seen_in: string[] }} MapScreen */
/**
 * @typedef {{ id: string, slug: string, status: string, source_ref: string | null,
 *   draft_reason: string | null, flags: string[], validation: { runs: { status: string,
 *   failure_code?: string, step_id?: string }[] } | null }} TestCase
 */

if (existsSync('.env')) process.loadEnvFile('.env')

const { values: opts } = parseArgs({
  options: {
    server: { type: 'string', default: process.env.CORAL_SERVER_URL ?? 'http://localhost:3000' },
    email: { type: 'string', default: process.env.CORAL_SEED_EMAIL },
    password: { type: 'string', default: process.env.CORAL_SEED_PASSWORD },
    project: { type: 'string', default: 'phase3-explore' },
    app: { type: 'string', default: 'com.saucelabs.mydemoapp.android' },
    apk: { type: 'string' },
    device: { type: 'string' },
    steps: { type: 'string', default: '25' },
    'max-minutes': { type: 'string', default: '15' },
    'min-screens': { type: 'string', default: '4' },
    'min-active': { type: 'string', default: '0' },
    'never-tap': { type: 'string', multiple: true, default: ['Log Out'] },
    download: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
})

const usage = `usage:
  node scripts/phase3-explore.mjs --apk <file.apk> [--steps 25] [--max-minutes 15] [--min-screens 4]
      [--min-active 0] [--never-tap <label>]... [--app <package>] [--device <udid>] [--download <dir>]
login: --email/--password or CORAL_SEED_EMAIL/CORAL_SEED_PASSWORD; server: --server or CORAL_SERVER_URL`

/**
 * @param {number} code
 * @param {string} message
 * @returns {never}
 */
function fail(code, message) {
  console.error(`phase3-explore: ${message}`)
  process.exit(code)
}

if (opts.help) {
  console.log(usage)
  process.exit(0)
}
if (!opts.email || !opts.password) fail(2, `missing login\n${usage}`)
if (!opts.apk) fail(2, `need --apk\n${usage}`)

const base = opts.server.replace(/\/$/, '')
let token = ''

/**
 * Calls the API; returns status and parsed JSON body without judging the status.
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
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
  return {
    status: res.status,
    body: /** @type {unknown} */ (text ? JSON.parse(text) : undefined),
    text,
  }
}

/**
 * Like call(), but throws unless the status is 2xx.
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<unknown>}
 */
async function api(method, path, body) {
  const res = await call(method, path, body)
  if (res.status < 200 || res.status > 299) {
    throw new Error(`${method} ${path} → ${res.status} ${res.text.slice(0, 500)}`)
  }
  return res.body
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Button labels compared like the popup guard does: case and spaces do not matter. */
const normal = (/** @type {string} */ text) =>
  text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()

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
 * Adds the --never-tap labels to the project's popups.yaml (one commit, when missing).
 * @param {Project} project
 * @returns {Promise<string[]>} every never_tap label of the file afterwards
 */
async function neverTap(project) {
  const file = /** @type {{ yaml: string, head_commit: string }} */ (
    await api('GET', `/projects/${project.id}/popups`)
  )
  const line = /^never_tap:\s*\[(.*)\]\s*$/m.exec(file.yaml)
  if (!line) throw new Error('popups.yaml has no one-line never_tap list')
  const labels = [...(line[1] ?? '').matchAll(/'([^']*)'|"([^"]*)"/g)].map(
    (m) => m[1] ?? m[2] ?? '',
  )
  const missing = (opts['never-tap'] ?? []).filter(
    (label) => !labels.some((l) => normal(l) === normal(label)),
  )
  if (missing.length === 0) return labels
  const all = [...labels, ...missing]
  const yaml = file.yaml.replace(
    line[0],
    `never_tap: [${all.map((l) => `'${l.replaceAll("'", "''")}'`).join(', ')}]`,
  )
  await api('PUT', `/projects/${project.id}/popups`, { yaml, base_commit: file.head_commit })
  return all
}

/**
 * @param {App} app
 * @returns {Promise<Build>}
 */
async function uploadBuild(app) {
  const apk = opts.apk ?? ''
  const form = new FormData()
  form.set('version', `explore-${new Date().toISOString()}`)
  form.set('file', new Blob([readFileSync(apk)]), basename(apk))
  return /** @type {Build} */ (await api('POST', `/apps/${app.id}/builds`, form))
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
    if (Date.now() > deadline) throw new Error('no idle Android device after 120 s')
    await sleep(1000)
  }
}

/**
 * The whole trace, a page at a time.
 * @param {string} id
 * @returns {Promise<Step[]>}
 */
async function trace(id) {
  /** @type {Step[]} */
  const steps = []
  for (;;) {
    const after = steps.at(-1)?.n ?? 0
    const page = /** @type {Step[]} */ (
      await api('GET', `/explorations/${id}/steps?after=${after}&limit=200`)
    )
    steps.push(...page)
    if (page.length < 200) return steps
  }
}

/**
 * Text, description and id of every locator of a recorded step (what it touched).
 * @param {unknown} step
 * @returns {string[]}
 */
function touched(step) {
  const target = /** @type {{ target?: Record<string, unknown>[] } | null} */ (step)?.target ?? []
  return target.flatMap((locator) =>
    [locator.text, locator.desc, locator.text_contains].filter((v) => typeof v === 'string'),
  )
}

/**
 * @param {string} url
 * @param {string} file
 */
async function download(url, file) {
  const res = await fetch(url.startsWith('/') ? `${base}${url}` : url, {
    headers: url.startsWith('/') ? { authorization: `Bearer ${token}` } : {},
  })
  if (res.status !== 200) return false
  await writeFile(file, new Uint8Array(await res.arrayBuffer()))
  return true
}

async function main() {
  await login()
  const { project, app } = await projectAndApp()
  const labels = await neverTap(project)
  const build = await uploadBuild(app)
  const device = await idleDevice()
  const created = /** @type {{ id: string }} */ (
    await api('POST', '/explorations', {
      project_id: project.id,
      app_id: app.id,
      build_id: build.id,
      device_id: device.id,
      budget: { max_steps: Number(opts.steps), max_minutes: Number(opts['max-minutes']) },
    })
  )
  console.log(`exploration ${created.id} on ${device.udid}: ${opts.steps} steps`)
  const deadline = Date.now() + (Number(opts['max-minutes']) + 5) * 60_000
  /** @type {Exploration} */
  let exploration
  let seen = -1
  for (;;) {
    exploration = /** @type {Exploration} */ (await api('GET', `/explorations/${created.id}`))
    if (exploration.stats.steps !== seen) {
      seen = exploration.stats.steps
      console.log(`  ${exploration.status}: ${seen} steps, ${exploration.stats.screens} screens`)
    }
    if (!['queued', 'running', 'writing', 'validating'].includes(exploration.status)) break
    if (Date.now() > deadline) throw new Error(`exploration still ${exploration.status}`)
    await sleep(2000)
  }

  const steps = await trace(created.id)
  const map = /** @type {{ screens: MapScreen[] }} */ (
    await api('GET', `/projects/${project.id}/appmap`)
  )
  const mine = map.screens.filter((s) => s.seen_in.includes(created.id))
  const { stats } = exploration
  console.log(
    `exploration ${created.id}: ${exploration.status} (${exploration.stop_reason}) — ${stats.steps} steps, ` +
      `${stats.screens} screens (${stats.new_screens} new), ${stats.transitions} transitions, ` +
      `${stats.refused} refused, ${stats.findings} findings, $${stats.cost_usd.toFixed(2)}`,
  )
  for (const screen of mine)
    console.log(`  screen ${screen.id} ${screen.fingerprint} ${screen.activity ?? '(no activity)'}`)

  /** @type {string[]} */
  const problems = []
  const ended = ['done', 'stopped']
  if (
    !ended.includes(exploration.status) ||
    ['error', 'ai_unavailable', 'device_offline', 'interrupted'].includes(
      exploration.stop_reason ?? '',
    )
  ) {
    problems.push(`ended ${exploration.status} (${exploration.stop_reason})`)
  }
  if (steps.length !== stats.steps)
    problems.push(`${steps.length} steps in the trace, ${stats.steps} counted`)
  const fingerprints = new Set(exploration.appmap.screens.map((s) => s.fingerprint))
  if (fingerprints.size < Number(opts['min-screens'])) {
    problems.push(`${fingerprints.size} screens, want ≥ ${opts['min-screens']}`)
  }
  if (mine.length !== exploration.appmap.screens.length) {
    problems.push(
      `${mine.length} of ${exploration.appmap.screens.length} screens in the project app map`,
    )
  }
  const noActivity = mine.filter((s) => !s.activity)
  if (noActivity.length > 0)
    problems.push(`no activity for ${noActivity.map((s) => s.id).join(', ')}`)
  const forbidden = new Set(labels.map(normal))
  for (const step of steps) {
    const hit = touched(step.step).find((text) => forbidden.has(normal(text)))
    if (hit) problems.push(`step ${step.n} touched never_tap "${hit}"`)
    if (step.flags.includes('never_tap')) problems.push(`step ${step.n} flagged never_tap`)
  }

  // What the Test writer made of it, and how each validation went (US3).
  const written = /** @type {TestCase[]} */ (
    await api('GET', `/projects/${project.id}/testcases?source=ai_explore`)
  ).filter((t) => t.source_ref === `exploration:${created.id}`)
  console.log(`test cases: ${stats.tests_written} written, ${stats.tests_active} active`)
  for (const t of written) {
    const runs = (t.validation?.runs ?? []).map((r) =>
      r.failure_code ? `${r.status} (${r.failure_code} at ${r.step_id ?? '?'})` : r.status,
    )
    const why = [t.draft_reason, ...t.flags].filter(Boolean).join(', ')
    console.log(
      `  ${t.slug}: ${t.status}${why ? ` (${why})` : ''} — validation ${runs.join(', ') || 'none'}`,
    )
  }
  const active = written.filter((t) => t.status === 'active').length
  if (active < Number(opts['min-active'])) {
    problems.push(`${active} active test case(s), want ≥ ${opts['min-active']}`)
  }

  if (opts.download) {
    const dir = opts.download
    await mkdir(join(dir, 'appmap'), { recursive: true })
    await mkdir(join(dir, 'trace'), { recursive: true })
    for (const [i, screen] of exploration.appmap.screens.entries()) {
      if (screen.screenshot_url) {
        await download(
          screen.screenshot_url,
          join(dir, 'appmap', `${String(i + 1).padStart(2, '0')}-${screen.id}.jpg`),
        )
      }
    }
    for (const step of steps) {
      if (step.screenshot_url) {
        await download(
          step.screenshot_url,
          join(dir, 'trace', `${String(step.n).padStart(3, '0')}-${step.status}.jpg`),
        )
      }
    }
    await mkdir(join(dir, 'testcases'), { recursive: true })
    for (const t of written) {
      const detail = /** @type {{ yaml: string }} */ (await api('GET', `/testcases/${t.id}`))
      await writeFile(join(dir, 'testcases', `${t.slug}.yaml`), detail.yaml)
    }
    await writeFile(
      join(dir, 'exploration.json'),
      JSON.stringify({ exploration, steps, map: mine, test_cases: written }, null, 2),
    )
  }

  for (const problem of problems) console.log(`  FAIL ${problem}`)
  console.log(problems.length === 0 ? 'PASS' : `FAIL (${problems.length} problem(s))`)
  return problems.length === 0 ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (/** @type {unknown} */ error) => fail(1, error instanceof Error ? error.message : String(error)),
)
