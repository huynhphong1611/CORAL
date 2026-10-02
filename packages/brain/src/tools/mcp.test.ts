import { mcpConfigSchema } from '@coral/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FAKE_OTP, startOtpServer } from '../testing/otp-server'
import { MAX_TOOL_RESULT } from './skills'
import { httpConnect, openMcp, type McpConnection } from './mcp'

// US7 (T057, research R5): the MCP client of an activity — only the tools mcp.yaml allows are
// offered, a side effect only when the file says so, a server's roles respected; every call is
// checked again, secrets resolved in headers and arguments and masked in results, results cut,
// a slow call given up, a server out of reach giving no tools.

const TOKEN = 'tok-1234567890'
const PHONE = '0909123456'
let otp: Awaited<ReturnType<typeof startOtpServer>>

beforeAll(async () => {
  otp = await startOtpServer({ token: TOKEN })
})
afterAll(() => otp.close())

const config = (tools: Record<string, object>, extra: object = {}) =>
  mcpConfigSchema.parse({
    schema: 'coral/mcp@1',
    servers: {
      otp: {
        url: otp.url,
        headers: { Authorization: 'Bearer ${secret:OTP_TOKEN}' },
        tools,
        ...extra,
      },
    },
  })
const secrets = { OTP_TOKEN: TOKEN, TEST_PHONE: PHONE }

describe('MCP client (T057)', () => {
  it('offers the allowed read-only tools, calls them, blocks the others', async () => {
    const session = await openMcp({
      config: config({ get_otp: {}, send_sms: {} }),
      secrets,
    })
    const tools = session.toolsFor('explorer')
    expect(tools.specs.map((s) => s.name)).toEqual(['otp__get_otp'])
    expect(tools.specs[0]?.inputSchema).toMatchObject({ properties: { phone: { type: 'string' } } })

    const before = otp.calls.length
    expect(await tools.call('otp__get_otp', { phone: '${secret:TEST_PHONE}' })).toMatchObject({
      ok: true,
      result: FAKE_OTP,
    })
    // The server got the phone number, the AI only its name.
    expect(otp.calls.slice(before)).toEqual([{ name: 'get_otp', args: { phone: PHONE } }])

    expect(await tools.call('otp__send_sms', { phone: '1', text: 'x' })).toEqual({
      ok: false,
      blocked: true,
      error: 'side_effects_disabled',
      result: JSON.stringify({ error: 'side_effects_disabled' }),
    })
    for (const name of ['otp__delete_user', 'otp__nope', 'other__get_otp', 'read_skill']) {
      expect(await tools.call(name, {}), name).toMatchObject({
        blocked: true,
        error: 'not_allowed',
      })
    }
    // Nothing blocked reached the server.
    expect(otp.calls.slice(before).map((c) => c.name)).toEqual(['get_otp'])
    await session.close()
  })

  it('offers a tool with side effects when allowed, and only to the roles named', async () => {
    const withSms = await openMcp({
      config: config({ get_otp: {}, send_sms: { side_effects: true } }),
      secrets,
    })
    expect(withSms.toolsFor('explorer').specs.map((s) => s.name)).toEqual([
      'otp__get_otp',
      'otp__send_sms',
    ])
    expect(
      await withSms.toolsFor('explorer').call('otp__send_sms', { phone: PHONE, text: 'hi' }),
    ).toMatchObject({ ok: true, result: 'sent' })
    await withSms.close()

    const writerOnly = await openMcp({
      config: config({ get_otp: {} }, { roles: ['writer'] }),
      secrets,
    })
    expect(writerOnly.toolsFor('explorer').specs).toEqual([])
    expect(await writerOnly.toolsFor('explorer').call('otp__get_otp', {})).toMatchObject({
      error: 'not_allowed',
    })
    expect(writerOnly.toolsFor('writer').specs.map((s) => s.name)).toEqual(['otp__get_otp'])
    await writerOnly.close()
  })

  it('masks secret values in results and cuts them at 8 KB', async () => {
    const masked = await openMcp({
      config: config({ get_otp: {} }),
      secrets: { ...secrets, LAST_CODE: FAKE_OTP },
    })
    expect(await masked.toolsFor('explorer').call('otp__get_otp', {})).toMatchObject({
      ok: true,
      result: '${secret:LAST_CODE}',
    })
    await masked.close()

    const fake = (callTool: McpConnection['callTool']) =>
      openMcp({
        config: config({ get_otp: {} }),
        secrets,
        connect: () =>
          Promise.resolve({
            listTools: () =>
              Promise.resolve([{ name: 'get_otp', inputSchema: {}, readOnly: true }]),
            callTool,
            close: () => Promise.resolve(),
          }),
      })
    const long = await fake(() => Promise.resolve({ text: 'x'.repeat(20_000), isError: false }))
    const result = await long.toolsFor('explorer').call('otp__get_otp', {})
    expect(result.result).toHaveLength(MAX_TOOL_RESULT)
    const slow = await fake(() => Promise.reject(new Error('Request timed out')))
    expect(await slow.toolsFor('explorer').call('otp__get_otp', {})).toMatchObject({
      ok: false,
      error: 'timeout',
    })
    const failing = await fake(() => Promise.resolve({ text: 'boom', isError: true }))
    expect(await failing.toolsFor('explorer').call('otp__get_otp', {})).toMatchObject({
      ok: false,
      error: 'server_error',
      result: 'boom',
    })
  })

  it('gives up a server that does not answer in time, keeping the others', async () => {
    const errors: string[] = []
    let closed = 0
    let late: (connection: McpConnection) => void = () => undefined
    const twoServers = mcpConfigSchema.parse({
      schema: 'coral/mcp@1',
      servers: {
        slow: { url: 'http://slow.test/mcp', tools: { get_otp: {} } },
        otp: {
          url: otp.url,
          headers: { Authorization: `Bearer ${TOKEN}` },
          tools: { get_otp: {} },
        },
      },
    })
    const started = Date.now()
    const session = await openMcp({
      config: twoServers,
      secrets,
      timeoutMs: 100,
      onError: (server) => errors.push(server),
      connect: (server) =>
        server.name === 'slow' ? new Promise((resolve) => (late = resolve)) : httpConnect(server),
    })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(errors).toEqual(['slow'])
    expect(session.toolsFor('explorer').specs.map((s) => s.name)).toEqual(['otp__get_otp'])
    // The slow server answering afterwards is let go.
    late({
      listTools: () => Promise.resolve([]),
      callTool: () => Promise.resolve({ text: '', isError: false }),
      close: () => {
        closed += 1
        return Promise.resolve()
      },
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(closed).toBe(1)
    await session.close()
  })

  it('gives no tools from a server it cannot reach (wrong token, nobody listening)', async () => {
    const errors: string[] = []
    const session = await openMcp({
      config: config({ get_otp: {} }),
      secrets: { ...secrets, OTP_TOKEN: 'wrong' },
      onError: (server) => errors.push(server),
    })
    expect(session.toolsFor('explorer').specs).toEqual([])
    expect(errors).toEqual(['otp'])
    await session.close()
  })
})
