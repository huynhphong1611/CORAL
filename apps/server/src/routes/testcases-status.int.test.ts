import { api, newId } from '@coral/shared'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { auditLog } from '../db/schema'
import { projectsRepo } from '../repos/projects'
import { testCasesRepo } from '../repos/test-cases'
import { startTestServer, type TestServer, type TestUser } from '../testing/test-server'

// US3 (T041): people change a test case's status by hand; activating one flagged because it taps
// a never_tap element is a separate approval (owner/admin, audited — SPEC §9.4).
let server: TestServer
let huynh: TestUser
let lan: TestUser
let mai: TestUser
let projectId = ''

const yaml = (slug: string) => `schema: coral/testcase@1
id: ${slug}
intent: 'Mở ${slug}'
platforms: [android]
steps:
  - id: s1
    action: launch
    expect: { visible_text: 'Products' }
`

beforeAll(async () => {
  server = await startTestServer()
  huynh = await server.newUser('Huynh')
  lan = await server.teammate(huynh, 'Lan', 'member')
  mai = await server.teammate(huynh, 'Mai', 'viewer')
  projectId = api.projectSchema.parse(
    (await server.call(huynh, { method: 'POST', url: '/projects', payload: { name: 'Status' } }))
      .body,
  ).id
})
afterAll(() => server.close())

const repo = () =>
  testCasesRepo(
    server.db,
    huynh.tenantId,
    server.store,
    projectsRepo(server.db, huynh.tenantId, server.store),
  )

async function testCase(slug: string) {
  const res = await server.call(huynh, {
    method: 'POST',
    url: `/projects/${projectId}/testcases`,
    payload: { yaml: yaml(slug) },
  })
  return api.savedTestCaseSchema.parse(res.body).id
}

const patch = (user: TestUser, id: string, status: string) =>
  server.call(user, { method: 'PATCH', url: `/testcases/${id}`, payload: { status } })

const audits = (id: string) =>
  server.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenantId, huynh.tenantId), eq(auditLog.target, id)))

describe('test case status (US3, T041)', () => {
  it('lets a member activate and quarantine a test case, audited; a viewer cannot', async () => {
    const id = await testCase(`plain-${newId().slice(-6)}`)
    await repo().setStatus(id, { status: 'draft', draftReason: 'validation_failed' })

    expect((await patch(mai, id, 'active')).status).toBe(403)
    const res = await patch(lan, id, 'active')
    expect(res.status).toBe(200)
    // Leaving draft clears why it was one.
    expect(api.testCaseSummarySchema.parse(res.body)).toMatchObject({
      id,
      status: 'active',
      draft_reason: null,
      flags: [],
    })
    expect((await patch(lan, id, 'quarantined')).body).toMatchObject({ status: 'quarantined' })
    expect((await repo().get(id)).updatedBy).toBe(lan.userId)
    expect((await audits(id)).map((a) => [a.action, a.actor, a.meta])).toEqual(
      expect.arrayContaining([
        ['testcase.status', `user:${lan.userId}`, { from: 'draft', to: 'active' }],
        ['testcase.status', `user:${lan.userId}`, { from: 'active', to: 'quarantined' }],
      ]),
    )

    expect((await patch(lan, id, 'retired')).status).toBe(400)
    expect((await patch(lan, newId(), 'active')).status).toBe(404)
  })

  it('needs an owner or admin to activate a test case that taps a never_tap element', async () => {
    const id = await testCase(`flagged-${newId().slice(-6)}`)
    await repo().setStatus(id, { status: 'draft', flags: ['needs_review_never_tap'] })

    const refused = await patch(lan, id, 'active')
    expect(refused).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } })
    // A member may still quarantine it or keep it a draft: the flag stays.
    expect((await patch(lan, id, 'quarantined')).body).toMatchObject({
      status: 'quarantined',
      flags: ['needs_review_never_tap'],
    })

    const approved = await patch(huynh, id, 'active')
    expect(approved.status).toBe(200)
    expect(approved.body).toMatchObject({ status: 'active', flags: [] })
    expect(await audits(id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'testcase.approve_never_tap',
          actor: `user:${huynh.userId}`,
          meta: { from: 'quarantined', to: 'active' },
        }),
      ]),
    )
    // Approved once: a member may now move it around.
    expect((await patch(lan, id, 'draft')).status).toBe(200)
    expect((await patch(lan, id, 'active')).status).toBe(200)
  })

  it('filters the list by source and status', async () => {
    const id = await testCase(`listed-${newId().slice(-6)}`)
    await patch(huynh, id, 'active')
    const list = async (query: string) =>
      api.testCaseSummarySchema
        .array()
        .parse(
          (
            await server.call(huynh, {
              method: 'GET',
              url: `/projects/${projectId}/testcases${query}`,
            })
          ).body,
        )
        .map((t) => t.id)

    expect(await list('?status=active')).toContain(id)
    expect(await list('?status=draft')).not.toContain(id)
    expect(await list('?source=manual&status=active')).toContain(id)
    expect(await list('?source=ai_explore')).toEqual([])
    const bad = await server.call(huynh, {
      method: 'GET',
      url: `/projects/${projectId}/testcases?source=robot`,
    })
    expect(bad.status).toBe(400)
  })
})
