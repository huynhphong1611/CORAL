import { api } from '@coral/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { devices, runItems, runs, runSteps } from '../db/schema'
import { startRunServer, type RunServer } from '../testing/run-server'
import type { TestUser } from '../testing/test-server'

// US5 T047: the editor's pictures — snapshots in the repo, then the latest run as a fallback.
let server: RunServer
let huynh: TestUser
let other: TestUser
let fixture: Awaited<ReturnType<RunServer['seed']>>
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7])
const TREE = JSON.stringify([{ ref: '0', text: 'Products' }])
const AUTHOR = { name: 'Huynh', email: 'huynh@example.com' }

const MENU_YAML = (image: string) => `schema: coral/testcase@1
id: menu
intent: Open the menu
platforms: [android]
steps:
  - id: s1
    action: launch
  - id: s2
    action: tap
    target:
      - android_id: id/menuIV
      - image: { path: ${image}, screen_width: 1080 }
    expect: { visible_text: Log In }
`

beforeAll(async () => {
  server = await startRunServer()
  huynh = await server.newUser('Huynh')
  other = await server.newUser('Other')
  fixture = await server.seed(huynh)
})
afterAll(() => server.close())

const create = (user: TestUser, yaml: string) =>
  server.call(user, {
    method: 'POST',
    url: `/projects/${fixture.project.id}/testcases`,
    payload: { yaml },
  })

describe('test case pictures (T047)', () => {
  let id = ''
  let head = ''

  it('rejects an image locator whose file is not in the repo (FR-022)', async () => {
    const res = await create(huynh, MENU_YAML('snap/menu/s2/element.png'))
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({
      error: {
        code: 'validation_failed',
        details: [{ code: 'image_not_found', path: 'steps[1].target[1].image', step_id: 's2' }],
      },
    })
  })

  it('lists the snapshots at head and serves their files by extension', async () => {
    await server.store.commitFiles(huynh.tenantId, fixture.project.id, {
      files: {
        'snap/menu/s1/screen.jpg': JPEG,
        'snap/menu/s1/tree.json': TREE,
        'snap/menu/s2/screen.jpg': JPEG,
        'snap/menu/s2/tree.json': TREE,
        'snap/menu/s2/element.png': PNG,
        // Not a step: a screen without its tree is left out.
        'snap/menu/s9/screen.jpg': JPEG,
      },
      author: AUTHOR,
      message: 'snapshots',
    })
    const res = await create(huynh, MENU_YAML('snap/menu/s2/element.png'))
    expect(res.status).toBe(201)
    const saved = api.savedTestCaseSchema.parse(res.body)
    id = saved.id
    head = saved.head_commit

    const list = await server.call(huynh, { method: 'GET', url: `/testcases/${id}/snapshots` })
    expect(list.status).toBe(200)
    const snapshots = api.testCaseSnapshotsSchema.parse(list.body)
    const file = (path: string) => `/testcases/${id}/files/${path}?commit=${head}`
    expect(snapshots).toEqual([
      {
        step_id: 's1',
        screen_url: file('snap/menu/s1/screen.jpg'),
        tree_url: file('snap/menu/s1/tree.json'),
        element_url: null,
      },
      {
        step_id: 's2',
        screen_url: file('snap/menu/s2/screen.jpg'),
        tree_url: file('snap/menu/s2/tree.json'),
        element_url: file('snap/menu/s2/element.png'),
      },
    ])

    const screen = await server.call(huynh, { method: 'GET', url: snapshots[1]?.screen_url ?? '' })
    expect(screen.status).toBe(200)
    expect(screen.res.headers['content-type']).toBe('image/jpeg')
    expect(screen.res.headers['cache-control']).toContain('immutable')
    expect(screen.res.rawPayload).toEqual(JPEG)
    const element = await server.call(huynh, {
      method: 'GET',
      url: snapshots[1]?.element_url ?? '',
    })
    expect(element.res.headers['content-type']).toBe('image/png')
    expect(element.res.rawPayload).toEqual(PNG)
    const tree = await server.call(huynh, { method: 'GET', url: snapshots[0]?.tree_url ?? '' })
    expect(tree.res.headers['content-type']).toContain('application/json')
    expect(tree.body).toEqual(JSON.parse(TREE))

    // Without ?commit= it reads the head, and may change: not cached for long.
    const latest = await server.call(huynh, {
      method: 'GET',
      url: `/testcases/${id}/files/snap/menu/s2/screen.jpg`,
    })
    expect(latest.status).toBe(200)
    expect(latest.res.headers['cache-control']).toBe('private, no-cache')
  })

  it('serves nothing outside snap/<slug>/ and nothing to another tenant (404)', async () => {
    for (const path of [
      'testcases/menu.yaml',
      'snap/login/s1/screen.jpg',
      'snap/menu/../../testcases/menu.yaml',
      'snap/menu/%2e%2e/%2e%2e/testcases/menu.yaml',
      'snap/menu/s2/..%2f..%2f..%2ftestcases/menu.yaml',
      'snap/menu//s2/screen.jpg',
      'snap/menu/s2/missing.png',
      '.git/config',
    ]) {
      const res = await server.call(huynh, { method: 'GET', url: `/testcases/${id}/files/${path}` })
      expect(res.status, path).toBe(404)
    }
    const unknownCommit = await server.call(huynh, {
      method: 'GET',
      url: `/testcases/${id}/files/snap/menu/s2/screen.jpg?commit=${'e'.repeat(40)}`,
    })
    expect(unknownCommit.status).toBe(404)

    for (const url of [
      `/testcases/${id}/snapshots`,
      `/testcases/${id}/files/snap/menu/s2/screen.jpg`,
      `/testcases/${id}/last-run-steps`,
    ]) {
      const res = await server.call(other, { method: 'GET', url })
      expect(res.status, url).toBe(404)
    }
  })

  it('checks image files when the editor saves (PUT)', async () => {
    const res = await server.call(huynh, {
      method: 'PUT',
      url: `/testcases/${id}`,
      payload: { yaml: MENU_YAML('snap/menu/s1/element.png'), base_commit: head },
    })
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toContain('image_not_found')
    const ok = await server.call(huynh, {
      method: 'PUT',
      url: `/testcases/${id}`,
      payload: {
        yaml: MENU_YAML('snap/menu/s2/element.png').replace('Open', 'Open up'),
        base_commit: head,
      },
    })
    expect(ok.status).toBe(200)
  })

  it('falls back to the step screenshots of the latest run that has them', async () => {
    const empty = await server.call(huynh, {
      method: 'GET',
      url: `/testcases/${id}/last-run-steps`,
    })
    expect(empty.status).toBe(200)
    expect(empty.body).toEqual([])

    const [device] = await server.db
      .insert(devices)
      .values({
        tenantId: huynh.tenantId,
        agentId: fixture.agent.id,
        platform: 'android',
        kind: 'emulator',
        model: 'Pixel',
        osVersion: '14',
        udid: 'emulator-5554',
      })
      .returning()
    if (!device) throw new Error('no device')
    /** A finished run of the test case with the given steps (none: it died before step 1). */
    async function finishedRun(finishedAt: Date, stepIds: string[]) {
      const [run] = await server.db
        .insert(runs)
        .values({
          tenantId: huynh.tenantId,
          projectId: fixture.project.id,
          buildId: fixture.build.id,
          deviceId: device?.id ?? '',
          status: stepIds.length > 0 ? 'passed' : 'error',
          popupsCommit: head,
          finishedAt,
        })
        .returning()
      if (!run) throw new Error('no run')
      const [item] = await server.db
        .insert(runItems)
        .values({
          tenantId: huynh.tenantId,
          runId: run.id,
          testCaseId: id,
          commit: head,
          position: 0,
          status: stepIds.length > 0 ? 'passed' : 'error',
          finishedAt,
        })
        .returning()
      if (!item) throw new Error('no item')
      for (const [stepIndex, stepId] of stepIds.entries()) {
        await server.db.insert(runSteps).values({
          tenantId: huynh.tenantId,
          runItemId: item.id,
          stepIndex,
          stepId,
          action: 'tap',
          status: 'passed',
          durationMs: 10,
          artifactPrefix: `${huynh.tenantId}/runs/${run.id}/${item.id}/${stepIndex}`,
        })
      }
      return run
    }
    await finishedRun(new Date('2026-09-01T10:00:00Z'), ['s1'])
    const latest = await finishedRun(new Date('2026-09-02T10:00:00Z'), ['s1', 's2'])
    // Later, but it has no step: not a picture source.
    await finishedRun(new Date('2026-09-03T10:00:00Z'), [])

    const res = await server.call(huynh, { method: 'GET', url: `/testcases/${id}/last-run-steps` })
    const steps = api.lastRunStepsSchema.parse(res.body)
    expect(steps.map((s) => [s.step_id, s.run_id, s.finished_at])).toEqual([
      ['s1', latest.id, '2026-09-02T10:00:00.000Z'],
      ['s2', latest.id, '2026-09-02T10:00:00.000Z'],
    ])
    expect(steps[1]?.screenshot_url).toContain(`${latest.id}`)
    expect(steps[1]?.screenshot_url).toContain('screenshot.png')
  })
})
