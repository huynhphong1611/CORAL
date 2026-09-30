import { newId } from '@coral/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startRunServer } from '../testing/run-server'
import type { TestUser } from '../testing/test-server'

// FR-002a, research R13: viewers look, everyone else in the tenant may change things.
let server: Awaited<ReturnType<typeof startRunServer>>
let owner: TestUser
let viewer: TestUser
let member: TestUser

beforeAll(async () => {
  // With the run routes (dispatcher, gateway) so every Phase 1 write route exists.
  server = await startRunServer()
  owner = await server.newUser('Owner')
  viewer = await server.teammate(owner, 'Viewer', 'viewer')
  member = await server.teammate(owner, 'Member', 'member')
})
afterAll(() => server.close())

const id = () => newId()
/** Every write route of Phase 1 (contracts/rest-api-phase2.md). */
const writes = () =>
  [
    ['POST', '/projects', { name: 'x' }],
    ['POST', `/projects/${id()}/apps`, { name: 'x', platform: 'android', package: 'com.x.y' }],
    ['POST', `/apps/${id()}/builds`, undefined],
    ['POST', `/projects/${id()}/testcases`, { yaml: 'x' }],
    ['PUT', `/testcases/${id()}`, { yaml: 'x', base_commit: 'abc1234' }],
    ['PUT', `/projects/${id()}/popups`, { yaml: 'x', base_commit: 'abc1234' }],
    ['POST', '/runs', {}],
    ['POST', `/runs/${id()}/cancel`, {}],
    ['POST', '/agents', { name: 'x' }],
    ['POST', `/agents/${id()}/revoke`, {}],
  ] as const

describe('roles (FR-002a)', () => {
  it('lets a viewer read the tenant', async () => {
    for (const url of ['/me', '/projects', '/runs', '/devices', '/agents']) {
      const res = await server.call(viewer, { method: 'GET', url })
      expect(res.status, url).toBe(200)
    }
  })

  it('refuses every write to a viewer, before looking at the request', async () => {
    for (const [method, url, payload] of writes()) {
      const res = await server.call(viewer, { method, url, ...(payload ? { payload } : {}) })
      expect(res.status, `${method} ${url}`).toBe(403)
      expect(res.body, `${method} ${url}`).toMatchObject({ error: { code: 'forbidden' } })
    }
  })

  it('lets members and owners write', async () => {
    for (const user of [member, owner]) {
      const res = await server.call(user, {
        method: 'POST',
        url: '/projects',
        payload: { name: `p-${newId()}` },
      })
      expect(res.status).toBe(201)
    }
    // Past the role check, a member meets the route's own validation.
    const bad = await server.call(member, { method: 'POST', url: '/runs', payload: {} })
    expect(bad.status).toBe(400)
  })

  it('still lets a viewer sign out', async () => {
    const res = await server.app.inject({ method: 'POST', url: '/auth/logout' })
    expect(res.statusCode).toBeLessThan(400)
  })
})
