import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FAKE_OTP, startOtpServer } from './otp-server'

// US7 (T058): the fake OTP MCP server lists its three tools — only get_otp read-only — answers
// get_otp with its code and refuses a client without its token.

let server: Awaited<ReturnType<typeof startOtpServer>>
beforeAll(async () => {
  server = await startOtpServer({ code: '135790', token: 'secret-token' })
})
afterAll(() => server.close())

const connect = async (token: string) => {
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  )
  return client
}

describe('fake OTP MCP server (T058)', () => {
  it('lists get_otp (read-only), send_sms and delete_user, and gives the code', async () => {
    const client = await connect('secret-token')
    const { tools } = await client.listTools()
    expect(tools.map((t) => [t.name, t.annotations?.readOnlyHint === true])).toEqual([
      ['get_otp', true],
      ['send_sms', false],
      ['delete_user', false],
    ])
    const result = await client.callTool({ name: 'get_otp', arguments: { phone: '0909' } })
    expect(result.content).toEqual([{ type: 'text', text: '135790' }])
    expect(server.calls).toEqual([{ name: 'get_otp', args: { phone: '0909' } }])
    await client.close()
    expect(FAKE_OTP).toBe('482913')
  })

  it('refuses a client without its token', async () => {
    await expect(connect('wrong')).rejects.toThrow()
  })
})
