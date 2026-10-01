import { readFileSync } from 'node:fs'
import { api, manualCaseSchema, parseYaml } from '@coral/shared'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { auditLog } from '../db/schema'
import { importSourceKey } from '../storage/keys'
import type { DeviceAgent } from '../testing/device-agent'
import { multipart } from '../testing/multipart'
import { startRunServer, type RunServer } from '../testing/run-server'
import { sampleDevice, sampleProject } from '../testing/sample-project'
import type { TestUser } from '../testing/test-server'
import { connectUi, type UiClient } from '../testing/ui-client'

// US6 (T053): imports over REST — a file uploaded becomes a preview (columns, mapping, cases,
// rows in error), the columns can be chosen again, a start writes the cases into the repo as one
// commit and one item each, a cancel leaves them not_processed; viewers and other tenants are
// kept out, and a tab follows the job over /ws/ui.

const fixture = (name: string) =>
  readFileSync(new URL(`../../../../fixtures/manual/${name}`, import.meta.url))

let server: RunServer
let huynh: TestUser
let mai: TestUser
let project: Awaited<ReturnType<typeof sampleProject>>
let deviceId = ''
const agents: DeviceAgent[] = []
const tabs: UiClient[] = []

beforeAll(async () => {
  server = await startRunServer({ explorer: {} })
  huynh = await server.newUser('Huynh')
  mai = await server.teammate(huynh, 'Mai', 'viewer')
  project = await sampleProject(server, huynh)
  const found = await sampleDevice(server, huynh, 'imports-1')
  agents.push(found.sample)
  deviceId = found.deviceId
})
afterAll(async () => {
  for (const tab of tabs) tab.close()
  for (const agent of agents) agent.close()
  await server.close()
})

const upload = (user: TestUser, name: string, data: Buffer, fields: Record<string, string> = {}) =>
  server.call(user, {
    method: 'POST',
    url: `/projects/${project.project.id}/imports`,
    ...multipart(fields, { name, data }),
  })
const call = (
  user: TestUser,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
) => server.call(user, { method, url, ...(payload ? { payload } : {}) })
const start = (user: TestUser, id: string) =>
  call(user, 'POST', `/imports/${id}/start`, {
    app_id: project.app.id,
    build_id: project.build.id,
    device_id: deviceId,
  })

describe('import routes (US6, T053)', { timeout: 60_000 }, () => {
  let started = ''

  it('reads an uploaded file into a preview and keeps the file', async () => {
    const res = await upload(huynh, 'login-en.csv', fixture('login-en.csv'))
    expect(res.status).toBe(201)
    const preview = api.importPreviewSchema.parse(res.body)
    expect(preview).toMatchObject({ format: 'csv', file_name: 'login-en.csv', errors: [] })
    expect(preview.mapping).toMatchObject({ title: 1, steps: [3], expected: [4] })
    expect(preview.cases.map((c) => c.title)).toEqual([
      'Log in with the demo account',
      'Open the cart',
    ])
    expect(
      await server.artifacts.getBytes(
        importSourceKey(huynh.tenantId, preview.import_job_id, 'csv'),
      ),
    ).toBeDefined()
    const job = api.importJobDetailSchema.parse(
      (await call(huynh, 'GET', `/imports/${preview.import_job_id}`)).body,
    )
    expect(job).toMatchObject({ status: 'preview', items: [], report: null, manual_commit: null })
    const [audit] = await server.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, huynh.tenantId), eq(auditLog.action, 'import.upload')))
    expect(audit?.target).toBe(preview.import_job_id)
    started = preview.import_job_id
  })

  it('asks for the columns it cannot guess, then reads the file under the chosen ones', async () => {
    const res = await upload(
      huynh,
      'odd.csv',
      Buffer.from('Case,What to do\nOpen the cart,Tap it\n'),
    )
    const preview = api.importPreviewSchema.parse(res.body)
    expect(preview).toMatchObject({ mapping: null, cases: [], errors: [{ code: 'no_mapping' }] })
    const remapped = await call(huynh, 'PATCH', `/imports/${preview.import_job_id}`, {
      mapping: { title: 0, steps: [1] },
    })
    expect(remapped.status).toBe(200)
    expect(api.importPreviewSchema.parse(remapped.body).cases.map((c) => c.steps)).toEqual([
      [{ action: 'Tap it' }],
    ])
    // A file with no case cannot start.
    const empty = await upload(huynh, 'errors.csv', Buffer.from('Title,Steps\nOnly a title,\n'))
    const id = api.importPreviewSchema.parse(empty.body).import_job_id
    expect((await start(huynh, id)).body).toMatchObject({ error: { code: 'no_cases' } })

    // A Gherkin file has no columns; a preview can be dropped, with its file.
    const feature = api.importPreviewSchema.parse(
      (await upload(huynh, 'shop.feature', fixture('shop.feature'))).body,
    )
    expect(feature).toMatchObject({ format: 'gherkin', mapping: null })
    expect(feature.cases).toHaveLength(4)
    expect(
      (
        await call(huynh, 'PATCH', `/imports/${feature.import_job_id}`, {
          mapping: { title: 0, steps: [1] },
        })
      ).status,
    ).toBe(400)
    expect((await call(huynh, 'DELETE', `/imports/${feature.import_job_id}`)).status).toBe(204)
    expect((await call(huynh, 'GET', `/imports/${feature.import_job_id}`)).status).toBe(404)
    expect(
      await server.artifacts.getBytes(
        importSourceKey(huynh.tenantId, feature.import_job_id, 'gherkin'),
      ),
    ).toBeUndefined()

    expect((await upload(huynh, 'notes.docx', Buffer.from('x'))).status).toBe(400)
  })

  it('starts: the cases in the repo as one commit, one item each; then cancels', async () => {
    const tab = await connectUi(server.url)
    tabs.push(tab)
    await tab.auth(huynh.token)
    tab.send('import.watch', { import_job_id: started })
    expect((await tab.next('import.updated')).payload).toMatchObject({ status: 'preview' })

    expect((await start(mai, started)).status).toBe(403)
    const res = await start(huynh, started)
    expect(res.status).toBe(202)
    const job = api.importJobSchema.parse(res.body)
    expect(job).toMatchObject({
      status: 'running',
      device_id: deviceId,
      budget: { max_cost_usd: 10, max_minutes: api.DEFAULT_IMPORT_MINUTES },
      stats: { total: 2, done: 0 },
    })
    expect((await tab.next('import.updated')).payload).toMatchObject({ status: 'running' })

    const paths = [
      `imports/${started}/001-log-in-with-the-demo-account.yaml`,
      `imports/${started}/002-open-the-cart.yaml`,
    ]
    for (const path of paths) {
      const yaml = await server.store.readFile(huynh.tenantId, project.project.id, path)
      expect(manualCaseSchema.safeParse(parseYaml(yaml ?? '').value).success).toBe(true)
    }
    const detail = api.importJobDetailSchema.parse(
      (await call(mai, 'GET', `/imports/${started}`)).body,
    )
    expect(detail.manual_commit).toMatch(/^[0-9a-f]{40}$/)
    expect(detail.items.map((i) => [i.n, i.title, i.status])).toEqual([
      [1, 'Log in with the demo account', 'pending'],
      [2, 'Open the cart', 'pending'],
    ])
    // Started once: no longer a preview.
    expect((await start(huynh, started)).status).toBe(409)
    expect(
      (await call(huynh, 'PATCH', `/imports/${started}`, { mapping: { title: 1, steps: [3] } }))
        .status,
    ).toBe(409)
    expect((await call(huynh, 'DELETE', `/imports/${started}`)).status).toBe(409)

    const cancelled = await call(huynh, 'POST', `/imports/${started}/cancel`)
    expect(cancelled.status).toBe(202)
    const after = api.importJobDetailSchema.parse(
      (await call(huynh, 'GET', `/imports/${started}`)).body,
    )
    expect(after).toMatchObject({
      status: 'cancelled',
      stats: { total: 2, done: 2, not_processed: 2 },
      report: { total: 2, active: 0, not_processed: 2 },
    })
    expect(after.items.map((i) => i.status)).toEqual(['not_processed', 'not_processed'])
    expect(
      await server.artifacts.getBytes(importSourceKey(huynh.tenantId, started, 'csv')),
    ).toBeUndefined()
    expect((await tab.next('import.updated')).payload).toMatchObject({ status: 'cancelled' })

    const list = api.importJobSchema
      .array()
      .parse((await call(mai, 'GET', `/imports?project_id=${project.project.id}`)).body)
    expect(list.map((j) => j.id)).toContain(started)
  })

  it('keeps viewers from uploading and other tenants out', async () => {
    expect((await upload(mai, 'login-en.csv', fixture('login-en.csv'))).status).toBe(403)
    const vy = await server.newUser('Vy')
    expect((await upload(vy, 'login-en.csv', fixture('login-en.csv'))).status).toBe(404)
    for (const url of [`/imports/${started}`, `/imports?project_id=${project.project.id}`]) {
      expect((await call(vy, 'GET', url)).status).toBe(404)
    }
    expect((await call(vy, 'POST', `/imports/${started}/cancel`)).status).toBe(404)
    const tab = await connectUi(server.url)
    tabs.push(tab)
    await tab.auth(vy.token)
    const watch = tab.send('import.watch', { import_job_id: started })
    expect((await tab.next('error', watch.id)).payload).toMatchObject({ code: 'not_found' })
  })
})
