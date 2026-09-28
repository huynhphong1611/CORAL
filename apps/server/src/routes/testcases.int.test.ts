import { api } from '@coral/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer, type TestUser } from '../testing/test-server'

let server: TestServer
let huynh: TestUser
let projectId = ''

const yaml = (intent: string, extraStep = '') => `schema: coral/testcase@1
id: login
intent: '${intent}'
platforms: [android]
steps:
  - id: s1
    action: launch
    expect: { visible_text: 'Login' }
  - id: s2
    action: tap
    target: [{ text: 'Login' }]${extraStep}
`

beforeAll(async () => {
  server = await startTestServer()
  huynh = await server.newUser('Huynh')
  projectId = api.projectSchema.parse(
    (await server.call(huynh, { method: 'POST', url: '/projects', payload: { name: 'TC' } })).body,
  ).id
})
afterAll(() => server.close())

describe('test cases', () => {
  let id = ''
  let first = ''

  it('creates a draft manual test case as a commit, returning warnings', async () => {
    const res = await server.call(huynh, {
      method: 'POST',
      url: `/projects/${projectId}/testcases`,
      payload: { yaml: yaml('Đăng nhập') },
    })
    expect(res.status).toBe(201)
    const saved = api.savedTestCaseSchema.parse(res.body)
    expect(saved.slug).toBe('login')
    expect(saved.warnings.map((w) => w.code)).toEqual(['no_expect_after_tap'])
    id = saved.id
    first = saved.head_commit
    expect(await server.store.readFile(huynh.tenantId, projectId, 'testcases/login.yaml')).toBe(
      yaml('Đăng nhập'),
    )

    const list = await server.call(huynh, {
      method: 'GET',
      url: `/projects/${projectId}/testcases`,
    })
    expect(api.testCaseSummarySchema.array().parse(list.body)).toMatchObject([
      {
        slug: 'login',
        status: 'draft',
        source: 'manual',
        intent: 'Đăng nhập',
        platforms: ['android'],
        head_commit: first,
      },
    ])
  })

  it('rejects a duplicate slug (409) and invalid YAML (400 with details)', async () => {
    const dup = await server.call(huynh, {
      method: 'POST',
      url: `/projects/${projectId}/testcases`,
      payload: { yaml: yaml('again') },
    })
    expect(dup.status).toBe(409)
    const bad = await server.call(huynh, {
      method: 'POST',
      url: `/projects/${projectId}/testcases`,
      payload: {
        yaml: yaml('x')
          .replace(
            "target: [{ text: 'Login' }]",
            "target: [{ point_pct: [0.5, 0.5] }, { text: 'Login' }]",
          )
          .replace('id: login', 'id: other'),
      },
    })
    expect(bad.status).toBe(400)
    const error = api.apiErrorSchema.parse(bad.body).error
    expect(error.code).toBe('validation_failed')
    expect(error.details).toMatchObject([
      { code: 'point_pct_not_last', path: 'steps[1].target[0]', step_id: 's2', line: 11 },
    ])
  })

  it('updates with base_commit, refuses a stale base (409) and keeps history', async () => {
    const put = await server.call(huynh, {
      method: 'PUT',
      url: `/testcases/${id}`,
      payload: {
        yaml: yaml('Đăng nhập rồi thấy trang chủ', "\n    expect: { visible_text: 'Home' }"),
        base_commit: first,
      },
    })
    expect(put.status).toBe(200)
    const second = (put.body as { head_commit: string }).head_commit
    expect(second).not.toBe(first)

    const stale = await server.call(huynh, {
      method: 'PUT',
      url: `/testcases/${id}`,
      payload: { yaml: yaml('ghi đè'), base_commit: first },
    })
    expect(stale.status).toBe(409)

    const head = api.testCaseDetailSchema.parse(
      (await server.call(huynh, { method: 'GET', url: `/testcases/${id}` })).body,
    )
    expect(head).toMatchObject({ head_commit: second, intent: 'Đăng nhập rồi thấy trang chủ' })
    const old = api.testCaseDetailSchema.parse(
      (await server.call(huynh, { method: 'GET', url: `/testcases/${id}?commit=${first}` })).body,
    )
    expect(old.yaml).toBe(yaml('Đăng nhập'))

    const history = api.historyEntrySchema
      .array()
      .parse((await server.call(huynh, { method: 'GET', url: `/testcases/${id}/history` })).body)
    expect(history.map((h) => h.commit)).toEqual([second, first])
    expect(history[0]?.author).toBe(`Huynh <${huynh.email}>`)
  })

  it('refuses renaming the slug', async () => {
    const head = api.testCaseDetailSchema.parse(
      (await server.call(huynh, { method: 'GET', url: `/testcases/${id}` })).body,
    )
    const res = await server.call(huynh, {
      method: 'PUT',
      url: `/testcases/${id}`,
      payload: {
        yaml: head.yaml.replace('id: login', 'id: renamed'),
        base_commit: head.head_commit,
      },
    })
    expect(res.status).toBe(400)
  })

  it('serialises concurrent updates from the same base: one wins, one gets 409', async () => {
    const head = api.testCaseDetailSchema.parse(
      (await server.call(huynh, { method: 'GET', url: `/testcases/${id}` })).body,
    )
    const results = await Promise.all(
      ['A', 'B'].map((tag) =>
        server.call(huynh, {
          method: 'PUT',
          url: `/testcases/${id}`,
          payload: { yaml: yaml(`bản ${tag}`), base_commit: head.head_commit },
        }),
      ),
    )
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
  })

  it('hides test cases of other tenants', async () => {
    const other = await server.newUser('Other')
    expect((await server.call(other, { method: 'GET', url: `/testcases/${id}` })).status).toBe(404)
    expect(
      (await server.call(other, { method: 'GET', url: `/projects/${projectId}/testcases` })).status,
    ).toBe(404)
  })
})

describe('popup rules', () => {
  it('reads and updates popups.yaml with base_commit', async () => {
    const current = api.popupsFileSchema.parse(
      (await server.call(huynh, { method: 'GET', url: `/projects/${projectId}/popups` })).body,
    )
    expect(current.yaml).toContain('never_tap')
    const next = `${current.yaml}\n# tuned\n`
    const put = await server.call(huynh, {
      method: 'PUT',
      url: `/projects/${projectId}/popups`,
      payload: { yaml: next, base_commit: current.head_commit },
    })
    expect(put.status).toBe(200)
    const head = (put.body as { head_commit: string }).head_commit
    const again = api.popupsFileSchema.parse(
      (await server.call(huynh, { method: 'GET', url: `/projects/${projectId}/popups` })).body,
    )
    expect(again).toEqual({ yaml: next, head_commit: head })
    const stale = await server.call(huynh, {
      method: 'PUT',
      url: `/projects/${projectId}/popups`,
      payload: { yaml: next, base_commit: current.head_commit },
    })
    expect(stale.status).toBe(409)
  })

  it('refuses rules that tap a never_tap button', async () => {
    const current = api.popupsFileSchema.parse(
      (await server.call(huynh, { method: 'GET', url: `/projects/${projectId}/popups` })).body,
    )
    const res = await server.call(huynh, {
      method: 'PUT',
      url: `/projects/${projectId}/popups`,
      payload: {
        yaml: current.yaml.replace("tap_any: ['Để sau',", "tap_any: ['Thanh toán', 'Để sau',"),
        base_commit: current.head_commit,
      },
    })
    expect(res.status).toBe(400)
    expect(api.apiErrorSchema.parse(res.body).error.details?.[0]?.code).toBe('rule_taps_never_tap')
  })
})
