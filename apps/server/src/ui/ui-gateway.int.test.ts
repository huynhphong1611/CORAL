import { newId } from '@coral/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { signAccessToken } from '../auth/tokens'
import { DEV_JWT_SECRET } from '../config'
import { startTestServer, type TestServer, type TestUser } from '../testing/test-server'
import { connectUi } from '../testing/ui-client'
import { UI_CLOSE, UiGateway } from './gateway'

let server: TestServer
let url: string
let gateway: UiGateway
let huynh: TestUser
let other: TestUser

beforeAll(async () => {
  gateway = new UiGateway({ jwtSecret: DEV_JWT_SECRET, authTimeoutMs: 300, expiryCheckMs: 100 })
  server = await startTestServer({ uiGateway: gateway })
  url = await server.listen()
  huynh = await server.newUser('Huynh')
  other = await server.newUser('Other')
})
afterAll(() => server.close())

describe('WS /ws/ui (contracts/ui-ws.md)', () => {
  it('authenticates in-band and answers ui.ready', async () => {
    const tab = await connectUi(url)
    const ready = await tab.auth(huynh.token)
    expect(ready.payload).toEqual({
      user_id: huynh.userId,
      tenant_id: huynh.tenantId,
      role: 'owner',
    })
    // A later ui.auth renews the session on the same connection.
    await tab.auth(huynh.token)
    tab.close()
  })

  it('closes 4401 for a bad token, a late ui.auth, or anything before it', async () => {
    const bad = await connectUi(url)
    bad.send('ui.auth', { access_token: 'nope' })
    expect((await bad.closed).code).toBe(UI_CLOSE.unauthorized)

    const silent = await connectUi(url)
    expect((await silent.closed).code).toBe(UI_CLOSE.unauthorized)

    const eager = await connectUi(url)
    eager.send('run.watch', { run_id: newId() })
    expect((await eager.closed).code).toBe(UI_CLOSE.unauthorized)
  })

  it('refuses to switch the user of a connection', async () => {
    const tab = await connectUi(url)
    await tab.auth(huynh.token)
    tab.send('ui.auth', { access_token: other.token })
    expect((await tab.closed).code).toBe(UI_CLOSE.unauthorized)
  })

  it('closes the session when its token expires without renewal', async () => {
    const soon = await signAccessToken(
      { sub: huynh.userId, tid: huynh.tenantId, role: 'owner' },
      DEV_JWT_SECRET,
      new Date(Date.now() - 15 * 60_000 + 1500),
    )
    const tab = await connectUi(url)
    await tab.auth(soon)
    expect((await tab.closed).code).toBe(UI_CLOSE.unauthorized)
  })

  it('answers invalid messages and closes 4400 after too many', async () => {
    const tab = await connectUi(url)
    await tab.auth(huynh.token)
    tab.ws.send('{not json')
    expect((await tab.next('error')).payload).toMatchObject({ code: 'invalid_message' })
    // Server-only types are invalid from a browser.
    tab.send('run.step', {
      run_id: newId(),
      run_item_id: newId(),
      step_index: 0,
      step_id: 's1',
      status: 'passed',
      degraded: false,
      duration_ms: 1,
    })
    expect((await tab.next('error')).payload).toMatchObject({ code: 'invalid_message' })
    tab.ws.send(Buffer.from([1, 2, 3]), { binary: true })
    expect((await tab.next('error')).payload).toMatchObject({ code: 'invalid_message' })
    for (let i = 0; i < 20; i += 1) tab.ws.send('x')
    expect((await tab.closed).code).toBe(UI_CLOSE.tooManyInvalid)
  })

  it('keeps tenants apart when broadcasting (P5) and sends binary frames', async () => {
    const mine = await connectUi(url)
    await mine.auth(huynh.token)
    const theirs = await connectUi(url)
    await theirs.auth(other.token)
    const run_id = newId()
    const sent = gateway.broadcastToTenant(huynh.tenantId, 'run.updated', {
      run_id,
      status: 'running',
      items: [],
    })
    expect(sent).toBe(1)
    expect((await mine.next('run.updated')).payload).toMatchObject({ run_id })
    await expect(theirs.next('run.updated', undefined, 300)).rejects.toThrow()

    const [connection] = gateway.connectionsOf(huynh.tenantId)
    expect(connection?.user.userId).toBe(huynh.userId)
    expect(gateway.sendBinary(connection?.id ?? '', new Uint8Array([7, 8, 9]))).toBe(true)
    expect([...(await mine.nextBinary())]).toEqual([7, 8, 9])
    mine.close()
    theirs.close()
  })

  it('routes client messages to handlers with the caller', async () => {
    gateway.on('run.watch', (ctx, message) => {
      ctx.reply('error', {
        code: 'echo',
        message: `${ctx.connection.user.userId} ${message.payload.run_id}`,
      })
    })
    const tab = await connectUi(url)
    await tab.auth(huynh.token)
    const run_id = newId()
    const request = tab.send('run.watch', { run_id })
    expect((await tab.next('error', request.id)).payload).toEqual({
      code: 'echo',
      message: `${huynh.userId} ${run_id}`,
    })
    // No handler yet: unsupported.
    const sub = tab.send('stream.subscribe', { device_id: newId() })
    expect((await tab.next('error', sub.id)).payload).toMatchObject({ code: 'unsupported' })
    tab.close()
  })
})
