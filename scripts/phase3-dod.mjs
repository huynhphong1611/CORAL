#!/usr/bin/env node
// Phase 3 DoD with real AI over the REST API (T063, quickstart §8) — run on a machine with an
// Android device or emulator, the server (`pnpm dev`) and AI keys in .env:
//   node scripts/phase3-dod.mjs --brains <brains.yaml> --apk <My Demo App 2.3.0 .apk>
//     [--switch gemini,claude] [--device <udid>] [--out dod-phase3] [--only sc002,sc001,sc003,sc004,sc007]
// The brains file is the tenant's routing with real providers and models (model names are
// configuration, never in this script); its daily limit is capped at --max-cost-day (15 USD).
// Each criterion prints ✅/❌ with its cost, in a new project:
//   SC-002  roles.explorer set to the first --switch provider, a short exploration; changed to the
//           second only through PUT /brains/config, another one; each answered by that provider.
//   SC-001  a full exploration: ≥ --min-screens screens, ≥ --min-active `active` test cases, each
//           run --replays times through the server, all passed.
//   SC-003  the fake OTP MCP server (fixtures/mcp/otp-server.ts, started here) returns the demo
//           user name (a password field only ever takes a secret by name, FR-014); mcp.yaml
//           allows only get_otp; a skill says the user name comes from otp__get_otp and the
//           password is its test data; a goal to log in → get_otp called ok, nothing else but
//           blocked calls.
//   SC-004  fixtures/manual/mydemo-10.csv imported → ≥ --min-import-active `active`, the others
//           a draft with a reason.
//   SC-007  scripts/phase1-e2e.mjs --scan-secrets over every exploration and import above.
// --out gets report.md (the table, costs, ids) and, unless --no-screenshots, pictures of the web
// pages (Playwright Chromium, signed in at --web). Exit code 0 only when every check passed.
import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { parse, stringify } from 'yaml'

/** @typedef {{ id: string, name: string }} Project */
/** @typedef {{ id: string, package_or_bundle_id: string }} App */
/** @typedef {{ id: string }} Build */
/** @typedef {{ id: string, udid: string, platform: string, status: string }} Device */
/**
 * @typedef {{ id: string, status: string, stop_reason: string | null,
 *   stats: { steps: number, screens: number, cost_usd: number, tests_written: number,
 *   tests_active: number },
 *   appmap: { screens: { fingerprint: string }[] },
 *   test_cases: { id: string, slug: string, status: string, draft_reason: string | null }[] }} Exploration
 */
/** @typedef {{ n: number, brain_call_id: string | null }} Step */
/**
 * @typedef {{ provider: string, model: string,
 *   content: { rounds: { tool_calls: { name: string, result: string }[] }[] } | null,
 *   tool_calls: { mcp_server: string, tool: string, ok: boolean, blocked: boolean,
 *   error: string | null }[] }} BrainCall
 */
/**
 * @typedef {{ id: string, status: string, stats: { total: number, done: number, active: number,
 *   cost_usd: number }, items: { n: number, title: string, status: string,
 *   reason: string | null }[] }} ImportJob
 */
/**
 * @typedef {{ schema: string, roles: Record<string, { provider: string, model?: string }>,
 *   fallback?: string[], providers?: Record<string, { model?: string }>,
 *   limits?: Record<string, number> }} BrainsFile
 */
/**
 * @typedef {{ id: string, title: string, ok: boolean, details: string[], cost: number,
 *   explorations: string[], imports: string[], pages: { file: string, path: string }[] }} Result
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OTP_SERVER = join(ROOT, 'fixtures/mcp/otp-server.ts')
const PHASE1 = join(ROOT, 'scripts/phase1-e2e.mjs')
const SECTIONS = ['sc002', 'sc001', 'sc003', 'sc004', 'sc007']

if (existsSync('.env')) process.loadEnvFile('.env')

const { values: opts } = parseArgs({
  options: {
    server: { type: 'string', default: process.env.CORAL_SERVER_URL ?? 'http://localhost:3000' },
    web: { type: 'string', default: 'http://localhost:5173' },
    email: { type: 'string', default: process.env.CORAL_SEED_EMAIL },
    password: { type: 'string', default: process.env.CORAL_SEED_PASSWORD },
    brains: { type: 'string' },
    apk: { type: 'string' },
    app: { type: 'string', default: 'com.saucelabs.mydemoapp.android' },
    device: { type: 'string' },
    project: { type: 'string' },
    out: { type: 'string', default: 'dod-phase3' },
    only: { type: 'string', default: SECTIONS.join(',') },
    switch: { type: 'string' },
    steps: { type: 'string', default: '60' },
    'short-steps': { type: 'string', default: '10' },
    'login-steps': { type: 'string', default: '25' },
    'min-screens': { type: 'string', default: '5' },
    'min-active': { type: 'string', default: '3' },
    replays: { type: 'string', default: '3' },
    csv: { type: 'string', default: join(ROOT, 'fixtures/manual/mydemo-10.csv') },
    'min-import-active': { type: 'string', default: '7' },
    'otp-port': { type: 'string', default: '3334' },
    'otp-host': { type: 'string', default: '127.0.0.1' },
    'otp-code': { type: 'string', default: 'bod@example.com' },
    'password-secret': { type: 'string', default: 'TEST_PASSWORD' },
    'max-cost-day': { type: 'string', default: '15' },
    'no-screenshots': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
})

const usage = `usage:
  node scripts/phase3-dod.mjs --brains <brains.yaml> --apk <file.apk> [--switch <provider>,<provider>]
      [--device <udid>] [--out <dir>] [--only ${SECTIONS.join(',')}] [--steps 60] [--short-steps 10]
      [--min-screens 5] [--min-active 3] [--replays 3] [--csv <file>] [--min-import-active 7]
      [--otp-port 3334] [--otp-host 127.0.0.1] [--otp-code <user name>] [--password-secret TEST_PASSWORD]
      [--max-cost-day 15] [--web http://localhost:5173] [--no-screenshots]
login: --email/--password or CORAL_SEED_EMAIL/CORAL_SEED_PASSWORD; server: --server or CORAL_SERVER_URL
--switch: the explorer's provider for SC-002, then the one it is changed to (default: the brains
  file's explorer, then its first fallback); each needs a model in the file (roles or providers).`

/**
 * @param {number} code
 * @param {string} message
 * @returns {never}
 */
function fail(code, message) {
  console.error(`phase3-dod: ${message}`)
  process.exit(code)
}

if (opts.help) {
  console.log(usage)
  process.exit(0)
}
if (!opts.email || !opts.password) fail(2, `missing login\n${usage}`)
if (!opts.brains || !opts.apk) fail(2, `need --brains and --apk\n${usage}`)
const only = new Set(opts.only.split(',').map((s) => s.trim().toLowerCase()))
const unknown = [...only].filter((s) => !SECTIONS.includes(s))
if (unknown.length > 0) fail(2, `unknown section(s) ${unknown.join(', ')}\n${usage}`)

const base = opts.server.replace(/\/$/, '')
let token = ''

/**
 * Calls the API; returns status and parsed JSON body without judging the status. A string body
 * is sent as YAML.
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
  else if (typeof body === 'string') {
    headers['content-type'] = 'application/yaml'
    init.body = body
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const res = await fetch(`${base}${path}`, init)
  const text = await res.text()
  /** @type {unknown} */
  let parsed
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    parsed = text
  }
  return { status: res.status, body: parsed, text }
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
const usd = (/** @type {number} */ n) => `$${n.toFixed(2)}`

async function login() {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-coral-client': 'cli' },
    body: JSON.stringify({ email: opts.email, password: opts.password }),
  })
  if (res.status !== 200) fail(2, `login failed: HTTP ${res.status}`)
  token = /** @type {{ access_token: string }} */ (await res.json()).access_token
}

// ---- brains ---------------------------------------------------------------------------------

const brains = /** @type {BrainsFile} */ (parse(readFileSync(opts.brains ?? '', 'utf8')))
const cap = Number(opts['max-cost-day'])
brains.limits = {
  ...brains.limits,
  max_cost_usd_per_day: Math.min(brains.limits?.max_cost_usd_per_day ?? cap, cap),
}
const explorer = brains.roles?.explorer ?? fail(2, 'the brains file has no roles.explorer')

/**
 * The model the file gives a provider: the explorer's own, another role's, or providers.<id>.
 * @param {string} provider
 */
function modelOf(provider) {
  if (explorer.provider === provider && explorer.model) return explorer.model
  const role = Object.values(brains.roles).find((r) => r.provider === provider && r.model)
  return role?.model ?? brains.providers?.[provider]?.model
}

const [first, second] = opts.switch
  ? opts.switch.split(',').map((s) => s.trim())
  : [explorer.provider, (brains.fallback ?? []).find((p) => p !== explorer.provider)]
if (only.has('sc002')) {
  if (!first || !second || first === second) {
    fail(2, `SC-002 needs two providers: --switch <a>,<b> or a fallback in the brains file`)
  }
  for (const p of [first, second]) {
    if (!modelOf(p)) fail(2, `no model for provider ${p} in the brains file (providers.${p}.model)`)
  }
}

/**
 * Stores the brains config with this explorer; a refusal lists why and stops the script.
 * @param {{ provider: string, model?: string }} role
 */
async function putBrains(role) {
  const config = { ...brains, roles: { ...brains.roles, explorer: role } }
  const res = await call('PUT', '/brains/config', stringify(config))
  if (res.status !== 200) {
    const details =
      /** @type {{ error?: { details?: { path?: string, line?: number, code: string, message: string }[] } }} */ (
        res.body
      ).error?.details ?? []
    const lines = details.map((d) => `  ${d.line ?? '?'}: ${d.code} ${d.message}`)
    fail(2, `PUT /brains/config → ${res.status}\n${lines.join('\n') || res.text.slice(0, 500)}`)
  }
}

// ---- project, device, explorations, runs ------------------------------------------------------

/** @returns {Promise<{ project: Project, app: App, build: Build }>} */
async function setUp() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const project = /** @type {Project} */ (
    await api('POST', '/projects', { name: opts.project ?? `phase3-dod-${stamp}` })
  )
  const app = /** @type {App} */ (
    await api('POST', `/projects/${project.id}/apps`, {
      platform: 'android',
      package_or_bundle_id: opts.app,
      name: opts.app,
    })
  )
  const apk = opts.apk ?? ''
  const form = new FormData()
  form.set('version', `dod-${stamp}`)
  form.set('file', new Blob([readFileSync(apk)]), basename(apk))
  const build = /** @type {Build} */ (await api('POST', `/apps/${app.id}/builds`, form))
  return { project, app, build }
}

/** @returns {Promise<Device>} */
async function idleDevice() {
  const deadline = Date.now() + 10 * 60_000
  for (;;) {
    const devices = /** @type {Device[]} */ (await api('GET', '/devices'))
    const device = devices.find(
      (d) =>
        d.platform === 'android' && d.status === 'idle' && (!opts.device || d.udid === opts.device),
    )
    if (device) return device
    if (Date.now() > deadline) throw new Error('no idle Android device after 10 min')
    await sleep(2000)
  }
}

const ACTIVE = ['queued', 'running', 'writing', 'validating']
const BROKEN = ['error', 'ai_unavailable', 'device_offline', 'interrupted', 'daily_limit']

/**
 * Starts an exploration on an idle device and waits until it, its test cases and their
 * validation are done.
 * @param {{ project: Project, app: App, build: Build }} ctx
 * @param {{ steps: number, goal?: string, maxTests?: number, label: string }} what
 * @returns {Promise<Exploration>}
 */
async function explore(ctx, what) {
  const device = await idleDevice()
  const created = /** @type {{ id: string }} */ (
    await api('POST', '/explorations', {
      project_id: ctx.project.id,
      app_id: ctx.app.id,
      build_id: ctx.build.id,
      device_id: device.id,
      ...(what.goal ? { goal: what.goal } : {}),
      budget: { max_steps: what.steps },
      ...(what.maxTests ? { max_tests: what.maxTests } : {}),
    })
  )
  console.log(`  ${what.label}: exploration ${created.id} on ${device.udid}`)
  const deadline = Date.now() + 90 * 60_000
  let seen = ''
  for (;;) {
    const e = /** @type {Exploration} */ (await api('GET', `/explorations/${created.id}`))
    const now = `${e.status} ${e.stats.steps} steps, ${e.stats.screens} screens, ${usd(e.stats.cost_usd)}`
    if (now !== seen) {
      seen = now
      console.log(`    ${now}`)
    }
    if (!ACTIVE.includes(e.status)) return e
    if (Date.now() > deadline) throw new Error(`exploration ${created.id} still ${e.status}`)
    await sleep(3000)
  }
}

/**
 * What went wrong with how an exploration ended; empty when it ended on its own.
 * @param {Exploration} e
 */
function ended(e) {
  return ['done', 'stopped'].includes(e.status) && !BROKEN.includes(e.stop_reason ?? '')
    ? []
    : [`exploration ${e.id} ended ${e.status} (${e.stop_reason})`]
}

/**
 * Every step of an exploration, a page at a time.
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
 * The brain calls behind the steps of an exploration.
 * @param {string} id
 * @returns {Promise<BrainCall[]>}
 */
async function brainCalls(id) {
  const ids = [
    ...new Set((await trace(id)).flatMap((s) => (s.brain_call_id ? [s.brain_call_id] : []))),
  ]
  /** @type {BrainCall[]} */
  const calls = []
  for (const callId of ids)
    calls.push(/** @type {BrainCall} */ (await api('GET', `/brain-calls/${callId}`)))
  return calls
}

/**
 * Runs one test case once through the server; resolves to the run's status.
 * @param {{ project: Project, build: Build }} ctx
 * @param {string} testCaseId
 */
async function runOnce(ctx, testCaseId) {
  const device = await idleDevice()
  const created = /** @type {{ id: string }} */ (
    await api('POST', '/runs', {
      project_id: ctx.project.id,
      build_id: ctx.build.id,
      device_id: device.id,
      test_case_ids: [testCaseId],
    })
  )
  const deadline = Date.now() + 15 * 60_000
  for (;;) {
    await sleep(1000)
    const run = /** @type {{ status: string }} */ (await api('GET', `/runs/${created.id}`))
    if (!['queued', 'running'].includes(run.status)) return { id: created.id, status: run.status }
    if (Date.now() > deadline) throw new Error(`run ${created.id} still ${run.status}`)
  }
}

/**
 * @param {string} id
 * @param {string} title
 * @returns {Result}
 */
const result = (id, title) => ({
  id,
  title,
  ok: false,
  details: [],
  cost: 0,
  explorations: [],
  imports: [],
  pages: [],
})

// ---- the criteria -------------------------------------------------------------------------------

/**
 * SC-002: the explorer's provider changed only through the brains config.
 * @param {{ project: Project, app: App, build: Build }} ctx
 */
async function sc002(ctx) {
  const r = result('SC-002', 'Explorer brain switched by brains.yaml only')
  /** @type {string[]} */
  const problems = []
  for (const provider of [first ?? '', second ?? '']) {
    await putBrains({ provider, model: modelOf(provider) ?? '' })
    const e = await explore(ctx, {
      steps: Number(opts['short-steps']),
      maxTests: 1,
      label: `SC-002 ${provider}`,
    })
    r.explorations.push(e.id)
    r.cost += e.stats.cost_usd
    problems.push(...ended(e))
    const answered = [...new Set((await brainCalls(e.id)).map((c) => c.provider))]
    r.details.push(
      `explorer = ${provider}: ${e.stats.steps} steps answered by ${answered.join(', ') || 'nobody'}`,
    )
    if (answered.length === 0 || answered.some((p) => p !== provider)) {
      problems.push(
        `exploration ${e.id} was answered by ${answered.join(', ') || 'no call'}, not ${provider}`,
      )
    }
  }
  // The file's own explorer again for what follows.
  await putBrains(explorer)
  const today = new Date().toISOString().slice(0, 10)
  const byProvider = /** @type {{ rows: { key: string, calls: number, cost_usd: number }[] }} */ (
    await api('GET', `/usage/ai?group=provider&from=${today}&to=${today}`)
  )
  r.details.push(
    `usage today by provider: ${byProvider.rows.map((u) => `${u.key} ${u.calls} calls ${usd(u.cost_usd)}`).join(', ')}`,
  )
  r.ok = problems.length === 0
  r.details.push(...problems.map((p) => `FAIL ${p}`))
  r.pages.push({
    file: 'sc002-trace.png',
    path: `/explorations/${r.explorations.at(-1)}?tab=trace`,
  })
  return r
}

/**
 * SC-001: a full exploration, its screens and active test cases, each replayed.
 * @param {{ project: Project, app: App, build: Build }} ctx
 */
async function sc001(ctx) {
  const r = result('SC-001', 'App map + active test cases that replay')
  const e = await explore(ctx, { steps: Number(opts.steps), label: 'SC-001' })
  r.explorations.push(e.id)
  r.cost += e.stats.cost_usd
  /** @type {string[]} */
  const problems = [...ended(e)]
  const screens = new Set(e.appmap.screens.map((s) => s.fingerprint)).size
  const active = e.test_cases.filter((t) => t.status === 'active')
  r.details.push(
    `${e.stats.steps} steps, ${screens} screens, ${e.test_cases.length} test cases written, ${active.length} active`,
  )
  for (const t of e.test_cases)
    r.details.push(`  ${t.slug}: ${t.status}${t.draft_reason ? ` (${t.draft_reason})` : ''}`)
  if (screens < Number(opts['min-screens']))
    problems.push(`${screens} screens, want ≥ ${opts['min-screens']}`)
  if (active.length < Number(opts['min-active'])) {
    problems.push(`${active.length} active test case(s), want ≥ ${opts['min-active']}`)
  }
  const replays = Number(opts.replays)
  for (const t of active) {
    let passed = 0
    for (let i = 0; i < replays; i++) {
      const run = await runOnce(ctx, t.id)
      if (run.status === 'passed') passed += 1
    }
    r.details.push(`  replay ${t.slug}: ${passed}/${replays} passed`)
    if (passed !== replays) problems.push(`${t.slug} passed ${passed}/${replays} replays`)
  }
  r.ok = problems.length === 0
  r.details.push(...problems.map((p) => `FAIL ${p}`))
  r.pages.push(
    { file: 'sc001-appmap.png', path: `/explorations/${e.id}?tab=appmap` },
    { file: 'sc001-trace.png', path: `/explorations/${e.id}?tab=trace` },
    { file: 'sc001-testcases.png', path: `/explorations/${e.id}?tab=testcases` },
  )
  return r
}

/** Starts the fake OTP MCP server; resolves once it answers /health. */
async function startOtp() {
  const port = opts['otp-port']
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', OTP_SERVER, '--port', port, '--code', opts['otp-code']],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let errors = ''
  child.stderr.on('data', (d) => (errors += String(d)))
  const deadline = Date.now() + 30_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the OTP server exited: ${errors.slice(0, 500)}`)
    const up = await fetch(`http://127.0.0.1:${port}/health`).then(
      (res) => res.status === 200,
      () => false,
    )
    if (up) return child
    if (Date.now() > deadline) {
      child.kill()
      throw new Error('the OTP server did not start within 30 s')
    }
    await sleep(300)
  }
}

const LOGIN_SKILL = `---
name: login-otp
description: Log in with the demo account; the user name is read with the MCP tool otp__get_otp
---
Open the menu, then Log In. For the user name type the text the tool otp__get_otp returns; for the
password type the password test data (a secret, by its name). Then tap the Login button.
`
const LOGIN_GOAL = 'Log in with the demo account (skill login-otp) until "Log Out"'

/**
 * SC-003: a real AI calls the one MCP tool mcp.yaml allows.
 * @param {{ project: Project, app: App, build: Build }} ctx
 */
async function sc003(ctx) {
  const r = result('SC-003', 'AI calls an allowed MCP tool; others blocked')
  const otp = await startOtp()
  try {
    const p = ctx.project.id
    const mcp = /** @type {{ head_commit: string }} */ (await api('GET', `/projects/${p}/mcp`))
    await api('PUT', `/projects/${p}/mcp`, {
      yaml: `schema: coral/mcp@1\nservers:\n  otp:\n    url: http://${opts['otp-host']}:${opts['otp-port']}/mcp\n    tools:\n      get_otp: {}\n`,
      base_commit: mcp.head_commit,
    })
    const head = /** @type {{ head_commit: string }} */ (
      await api('GET', `/projects/${p}/agents-md`)
    )
    await api('PUT', `/projects/${p}/skills/login-otp`, {
      skill_md: LOGIN_SKILL,
      rules_yaml: `schema: coral/skill-rules@1\ntest_data:\n  password: '\${secret:${opts['password-secret']}}'\n`,
      base_commit: head.head_commit,
    })
    const e = await explore(ctx, {
      steps: Number(opts['login-steps']),
      goal: LOGIN_GOAL,
      label: 'SC-003',
    })
    r.explorations.push(e.id)
    r.cost += e.stats.cost_usd
    const calls = await brainCalls(e.id)
    const tools = calls.flatMap((c) => c.tool_calls)
    const got = tools.filter((t) => t.mcp_server === 'otp' && t.tool === 'get_otp' && t.ok)
    const blocked = tools.filter((t) => t.blocked)
    const other = tools.filter(
      (t) =>
        !t.blocked && t.mcp_server !== 'coral' && !(t.mcp_server === 'otp' && t.tool === 'get_otp'),
    )
    r.details.push(
      `tool calls: ${got.length} otp__get_otp ok, ${blocked.length} blocked (${blocked.map((t) => `${t.mcp_server}__${t.tool} ${t.error}`).join(', ') || 'none'})`,
      `goal: ${e.stop_reason === 'goal_reached' ? 'reached (logged in)' : `not reached (${e.stop_reason})`} — informative, not a criterion`,
    )
    const masked = calls.some((c) =>
      (c.content?.rounds ?? []).some((round) =>
        round.tool_calls.some((t) => t.name === 'otp__get_otp' && t.result.includes('${secret:')),
      ),
    )
    if (masked) {
      r.details.push(
        `the tool's value (--otp-code) equals a secret of the server: the AI saw \${secret:NAME}, not the value (FR-013); pick another --otp-code to see it typed`,
      )
    }
    /** @type {string[]} */
    const problems = [...ended(e)]
    if (got.length === 0) problems.push('otp__get_otp was never called successfully')
    if (other.length > 0)
      problems.push(
        `calls not allowed went through: ${other.map((t) => `${t.mcp_server}__${t.tool}`).join(', ')}`,
      )
    r.ok = problems.length === 0
    r.details.push(...problems.map((p) => `FAIL ${p}`))
    r.pages.push({ file: 'sc003-trace.png', path: `/explorations/${e.id}?tab=trace` })
  } finally {
    otp.kill()
  }
  return r
}

/**
 * SC-004: the 10 manual test cases of My Demo App imported.
 * @param {{ project: Project, app: App, build: Build }} ctx
 */
async function sc004(ctx) {
  const r = result('SC-004', 'Import 10 manual test cases')
  const csv = opts.csv
  const form = new FormData()
  form.set('file', new Blob([readFileSync(csv)]), basename(csv))
  const preview = /** @type {{ import_job_id: string, cases: unknown[], errors: unknown[] }} */ (
    await api('POST', `/projects/${ctx.project.id}/imports`, form)
  )
  r.imports.push(preview.import_job_id)
  r.details.push(
    `${basename(csv)}: ${preview.cases.length} cases, ${preview.errors.length} rows in error`,
  )
  const device = await idleDevice()
  await api('POST', `/imports/${preview.import_job_id}/start`, {
    app_id: ctx.app.id,
    build_id: ctx.build.id,
    device_id: device.id,
  })
  console.log(`  SC-004: import ${preview.import_job_id} on ${device.udid}`)
  const deadline = Date.now() + 250 * 60_000
  /** @type {ImportJob} */
  let job
  let seen = ''
  for (;;) {
    job = /** @type {ImportJob} */ (await api('GET', `/imports/${preview.import_job_id}`))
    const now = `${job.status} ${job.stats.done}/${job.stats.total} done, ${job.stats.active} active, ${usd(job.stats.cost_usd)}`
    if (now !== seen) {
      seen = now
      console.log(`    ${now}`)
    }
    if (!['preview', 'running'].includes(job.status)) break
    if (Date.now() > deadline) throw new Error(`import ${job.id} still ${job.status}`)
    await sleep(5000)
  }
  r.cost += job.stats.cost_usd
  const active = job.items.filter((i) => i.status === 'active')
  for (const item of job.items) {
    r.details.push(
      `  ${item.n}. ${item.title}: ${item.status}${item.reason ? ` (${item.reason})` : ''}`,
    )
  }
  /** @type {string[]} */
  const problems = []
  if (job.status !== 'done') problems.push(`import ended ${job.status}`)
  if (active.length < Number(opts['min-import-active'])) {
    problems.push(`${active.length} active, want ≥ ${opts['min-import-active']}`)
  }
  const unexplained = job.items.filter((i) => i.status !== 'active' && !i.reason)
  if (unexplained.length > 0)
    problems.push(`no reason for ${unexplained.map((i) => i.n).join(', ')}`)
  r.details.unshift(`${active.length}/${job.items.length} active`)
  r.ok = problems.length === 0
  r.details.push(...problems.map((p) => `FAIL ${p}`))
  r.pages.push({ file: 'sc004-import.png', path: `/imports/${job.id}` })
  return r
}

/**
 * SC-007: no secret value in what any of the above stored or sent to the AI.
 * @param {Result[]} done
 */
async function sc007(done) {
  const r = result('SC-007', 'No secret value in AI calls, trace, app map, test cases')
  const args = [
    PHASE1,
    ...['--server', base, '--email', opts.email ?? '', '--password', opts.password ?? ''],
    '--scan-secrets',
    ...done.flatMap((d) => d.explorations.flatMap((id) => ['--exploration', id])),
    ...done.flatMap((d) => d.imports.flatMap((id) => ['--import', id])),
  ]
  if (args.length === 8) {
    r.details.push('nothing to scan: no exploration or import ran')
    return r
  }
  const scan = await promisify(execFile)(process.execPath, args, { maxBuffer: 16 << 20 }).then(
    (out) => ({ code: 0, stdout: out.stdout }),
    (/** @type {{ code?: number, stdout?: string, stderr?: string }} */ e) => ({
      code: e.code ?? 1,
      stdout: `${e.stdout ?? ''}${e.stderr ?? ''}`,
    }),
  )
  r.details.push(...scan.stdout.trim().split('\n'))
  r.ok = scan.code === 0
  return r
}

// ---- report ---------------------------------------------------------------------------------------

/**
 * Pictures of the pages each criterion names, signed in at --web; best effort.
 * @param {Result[]} done
 * @param {string} dir
 * @returns {Promise<string[]>} notes on what could not be taken
 */
async function screenshots(done, dir) {
  const pages = done.flatMap((d) => d.pages)
  if (opts['no-screenshots'] || pages.length === 0) return []
  /** @type {typeof import('@playwright/test').chromium} */
  let chromium
  try {
    ;({ chromium } = await import('@playwright/test'))
  } catch {
    return ['no screenshots: @playwright/test is not installed']
  }
  /** @type {string[]} */
  const notes = []
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  const browser = await chromium.launch(executablePath ? { executablePath } : {}).catch((e) => {
    notes.push(
      `no screenshots: Chromium did not start (${String(e).split('\n')[0]}); try pnpm exec playwright install chromium`,
    )
    return undefined
  })
  if (!browser) return notes
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    await page.goto(`${opts.web}/login`)
    await page.getByLabel('Email').fill(opts.email ?? '')
    await page.getByLabel('Password').fill(opts.password ?? '')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.getByRole('button', { name: 'Sign out' }).waitFor({ timeout: 15_000 })
    await mkdir(join(dir, 'pages'), { recursive: true })
    for (const shot of pages) {
      try {
        await page.goto(`${opts.web}${shot.path}`)
        await page.waitForLoadState('networkidle')
        await sleep(1500)
        await page.screenshot({ path: join(dir, 'pages', shot.file), fullPage: true })
      } catch (e) {
        notes.push(`${shot.file}: ${String(e).split('\n')[0]}`)
      }
    }
  } catch (e) {
    notes.push(`no screenshots: cannot sign in at ${opts.web} (${String(e).split('\n')[0]})`)
  } finally {
    await browser.close()
  }
  return notes
}

/**
 * @param {Result[]} done
 * @param {{ project: Project, started: Date }} run
 * @param {string[]} notes
 */
function reportOf(done, run, notes) {
  const total = done.reduce((n, r) => n + r.cost, 0)
  const lines = [
    '# Phase 3 DoD — real AI',
    '',
    `- Server: ${base} · project \`${run.project.name}\` (${run.project.id})`,
    `- Brains: explorer ${explorer.provider}${explorer.model ? ` / ${explorer.model}` : ''}${
      only.has('sc002') ? `; SC-002 switched ${first} → ${second}` : ''
    }`,
    `- Started ${run.started.toISOString()}, took ${Math.round((Date.now() - run.started.getTime()) / 60_000)} min, AI cost ${usd(total)}`,
    '',
    '| Criterion | | What | Cost |',
    '|---|---|---|---|',
    ...done.map((r) => `| ${r.id} | ${r.ok ? '✅' : '❌'} | ${r.title} | ${usd(r.cost)} |`),
    '',
  ]
  for (const r of done) {
    lines.push(`## ${r.id} ${r.ok ? '✅' : '❌'} ${r.title}`, '')
    lines.push(...r.details.map((d) => `    ${d}`), '')
    if (r.explorations.length > 0) lines.push(`Explorations: ${r.explorations.join(', ')}`, '')
    if (r.imports.length > 0) lines.push(`Imports: ${r.imports.join(', ')}`, '')
    for (const p of r.pages) lines.push(`![${p.file}](pages/${p.file})`, '')
  }
  if (notes.length > 0) lines.push('## Notes', '', ...notes.map((n) => `- ${n}`), '')
  return lines.join('\n')
}

async function main() {
  const started = new Date()
  await login()
  await putBrains(explorer)
  const ctx = await setUp()
  console.log(
    `project ${ctx.project.name} · app ${ctx.app.package_or_bundle_id} · build ${ctx.build.id}`,
  )
  /** @type {Result[]} */
  const done = []
  /** @type {[string, () => Promise<Result>][]} */
  const plan = [
    ['sc002', () => sc002(ctx)],
    ['sc001', () => sc001(ctx)],
    ['sc003', () => sc003(ctx)],
    ['sc004', () => sc004(ctx)],
    ['sc007', () => sc007(done)],
  ]
  for (const [id, run] of plan) {
    if (!only.has(id)) continue
    console.log(`${id.toUpperCase().replace('SC', 'SC-')}:`)
    /** @type {Result} */
    let r
    try {
      r = await run()
    } catch (error) {
      r = result(id.toUpperCase().replace('SC', 'SC-'), 'did not finish')
      r.details.push(`FAIL ${error instanceof Error ? error.message : String(error)}`)
    }
    done.push(r)
    console.log(`${r.ok ? '✅' : '❌'} ${r.id} ${r.title} — ${usd(r.cost)}`)
    for (const d of r.details) console.log(`    ${d}`)
  }
  const dir = opts.out
  await mkdir(dir, { recursive: true })
  const notes = await screenshots(done, dir)
  for (const n of notes) console.log(`note: ${n}`)
  await writeFile(join(dir, 'report.md'), reportOf(done, { project: ctx.project, started }, notes))
  await writeFile(join(dir, 'results.json'), JSON.stringify(done, null, 2))
  const passed = done.filter((r) => r.ok).length
  console.log(`${passed}/${done.length} criteria passed — report in ${join(dir, 'report.md')}`)
  return passed === done.length ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (/** @type {unknown} */ error) => fail(1, error instanceof Error ? error.message : String(error)),
)
