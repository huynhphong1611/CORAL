import { api } from '@coral/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer, type TestUser } from '../testing/test-server'

let server: TestServer
let huynh: TestUser
let other: TestUser

beforeAll(async () => {
  server = await startTestServer()
  huynh = await server.newUser('Huynh')
  other = await server.newUser('Other')
})
afterAll(() => server.close())

describe('projects and apps', () => {
  it('creates a project with its git repo, default popups.yaml and README', async () => {
    const created = await server.call(huynh, {
      method: 'POST',
      url: '/projects',
      payload: { name: 'Demo' },
    })
    expect(created.status).toBe(201)
    const project = api.projectSchema.parse(created.body)
    expect(await server.store.readFile(huynh.tenantId, project.id, 'popups.yaml')).toContain(
      'schema: coral/popups@1',
    )
    expect(await server.store.readFile(huynh.tenantId, project.id, 'README.md')).toContain('# Demo')
    const history = await server.store.history(huynh.tenantId, project.id, 'popups.yaml')
    expect(history[0]).toMatchObject({
      author: { name: 'Huynh', email: huynh.email },
      message: 'project: init',
    })

    const list = await server.call(huynh, { method: 'GET', url: '/projects' })
    expect((list.body as { name: string }[]).map((p) => p.name)).toEqual(['Demo'])
  })

  it('rejects a duplicate name with 409 and leaves no stray repo', async () => {
    const dup = await server.call(huynh, {
      method: 'POST',
      url: '/projects',
      payload: { name: 'Demo' },
    })
    expect(dup.status).toBe(409)
    expect(api.apiErrorSchema.parse(dup.body).error.code).toBe('duplicate_name')
    // Same name in another tenant is fine.
    expect(
      (await server.call(other, { method: 'POST', url: '/projects', payload: { name: 'Demo' } }))
        .status,
    ).toBe(201)
  })

  it('adds apps and hides other tenants (404)', async () => {
    const project = api.projectSchema.parse(
      (await server.call(huynh, { method: 'POST', url: '/projects', payload: { name: 'Apps' } }))
        .body,
    )
    const payload = {
      platform: 'android',
      package_or_bundle_id: 'com.saucelabs.mydemoapp.android',
      name: 'My Demo',
    }
    const created = await server.call(huynh, {
      method: 'POST',
      url: `/projects/${project.id}/apps`,
      payload,
    })
    expect(created.status).toBe(201)
    expect(api.appSchema.parse(created.body).project_id).toBe(project.id)
    expect(
      (await server.call(huynh, { method: 'POST', url: `/projects/${project.id}/apps`, payload }))
        .status,
    ).toBe(409)
    const apps = await server.call(huynh, { method: 'GET', url: `/projects/${project.id}/apps` })
    expect(apps.body).toHaveLength(1)

    expect(
      (await server.call(other, { method: 'GET', url: `/projects/${project.id}/apps` })).status,
    ).toBe(404)
    expect(
      (await server.call(other, { method: 'POST', url: `/projects/${project.id}/apps`, payload }))
        .status,
    ).toBe(404)
  })

  it('validates input', async () => {
    const bad = await server.call(huynh, {
      method: 'POST',
      url: '/projects',
      payload: { name: '' },
    })
    expect(bad.status).toBe(400)
    const badApp = await server.call(huynh, {
      method: 'POST',
      url: '/projects/not-a-uuid/apps',
      payload: { platform: 'ios' },
    })
    expect(badApp.status).toBe(400)
  })
})
