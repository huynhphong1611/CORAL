import { createServer, type Server } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

/** The code the fake OTP server gives (the fake My Demo App's Verify Code screen accepts it). */
export const FAKE_OTP = '482913'

export interface OtpServerCalls {
  name: string
  args: unknown
}

/**
 * A fake MCP server for US7 (research R5, SC-003): `get_otp` reads a code (read-only), `send_sms`
 * sends a message (a side effect) and `delete_user` deletes an account (never to be allowed).
 * Streamable HTTP at `/mcp`, stateless; every call is kept in `calls`.
 */
export async function startOtpServer(
  options: { port?: number; code?: string; token?: string } = {},
): Promise<{ url: string; calls: OtpServerCalls[]; close: () => Promise<void> }> {
  const calls: OtpServerCalls[] = []
  const code = options.code ?? FAKE_OTP

  const mcp = () => {
    const server = new McpServer({ name: 'coral-fake-otp', version: '1.0.0' })
    server.registerTool(
      'get_otp',
      {
        description: 'The last one-time code sent to a phone number by SMS.',
        inputSchema: { phone: z.string().optional() },
        annotations: { readOnlyHint: true },
      },
      (args) => {
        calls.push({ name: 'get_otp', args })
        return { content: [{ type: 'text', text: code }] }
      },
    )
    server.registerTool(
      'send_sms',
      {
        description: 'Send an SMS to a phone number.',
        inputSchema: { phone: z.string(), text: z.string() },
      },
      (args) => {
        calls.push({ name: 'send_sms', args })
        return { content: [{ type: 'text', text: 'sent' }] }
      },
    )
    server.registerTool(
      'delete_user',
      {
        description: 'Delete a user account.',
        inputSchema: { email: z.string() },
        annotations: { destructiveHint: true },
      },
      (args) => {
        calls.push({ name: 'delete_user', args })
        return { content: [{ type: 'text', text: 'deleted' }] }
      },
    )
    return server
  }

  const http: Server = createServer((req, res) => {
    void (async () => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
        return
      }
      if (!req.url?.startsWith('/mcp')) {
        res.writeHead(404).end()
        return
      }
      if (options.token && req.headers.authorization !== `Bearer ${options.token}`) {
        res.writeHead(401).end()
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body: unknown = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
        : undefined
      // Stateless: a server and a transport per request.
      const server = mcp()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end()
    })
  })
  await new Promise<void>((resolve) => http.listen(options.port ?? 0, '127.0.0.1', resolve))
  const address = http.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections()
        http.close(() => resolve())
      }),
  }
}
