import type { BrainRole, McpConfig } from '@coral/shared'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ToolOutcome, ToolSet, ToolSpec } from '../brain'
import { MAX_TOOL_RESULT } from './skills'

/** A tool call that takes longer is given up (research R5). */
export const MCP_TIMEOUT_MS = 20_000
/** Between the server's name and the tool's in what the AI sees: `otp__get_otp`. */
export const MCP_SEPARATOR = '__'

const SECRET_REF = /\$\{secret:([A-Za-z_][A-Za-z0-9_]*)\}/g

/** A tool as an MCP server lists it. */
export interface McpListedTool {
  name: string
  description?: string | undefined
  inputSchema: Record<string, unknown>
  /** `annotations.readOnlyHint: true`; any other tool has side effects. */
  readOnly: boolean
}

/** What the brain needs of a connected MCP server. */
export interface McpConnection {
  listTools(): Promise<McpListedTool[]>
  callTool(
    name: string,
    args: unknown,
    timeoutMs: number,
  ): Promise<{ text: string; isError: boolean }>
  close(): Promise<void>
}

export type McpConnect = (server: {
  name: string
  url: string
  headers: Record<string, string>
}) => Promise<McpConnection>

/** A remote server over Streamable HTTP (the SDK's client). */
export const httpConnect: McpConnect = async ({ url, headers }) => {
  const client = new Client({ name: 'coral', version: '0.1.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }),
  )
  return {
    async listTools() {
      const { tools } = await client.listTools()
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        readOnly: tool.annotations?.readOnlyHint === true,
      }))
    },
    async callTool(name, args, timeoutMs) {
      const result = await client.callTool(
        { name, arguments: (args ?? {}) as Record<string, unknown> },
        undefined,
        { timeout: timeoutMs },
      )
      const content = Array.isArray(result.content) ? result.content : []
      const text = content
        .map((c: { type?: unknown; text?: unknown }) =>
          c.type === 'text' && typeof c.text === 'string' ? c.text : '',
        )
        .filter(Boolean)
        .join('\n')
      return { text, isError: result.isError === true }
    },
    close: () => client.close(),
  }
}

export interface McpSessionOptions {
  config: McpConfig
  /** Secret values by name: `${secret:NAME}` in headers and arguments; masked in results. */
  secrets: Readonly<Record<string, string>>
  connect?: McpConnect
  timeoutMs?: number
  /** A server that cannot be reached gives no tools; the activity goes on. */
  onError?: (server: string, error: unknown) => void
}

export interface McpSession {
  /** The tools `role` may call (contracts/brain.md §4). */
  toolsFor(role: BrainRole): ToolSet
  close(): Promise<void>
}

/** `${secret:NAME}` replaced by its value, in a string or deep in an object. */
function resolveSecrets(value: unknown, secrets: Readonly<Record<string, string>>): unknown {
  if (typeof value === 'string') {
    return value.replace(SECRET_REF, (ref, name: string) => secrets[name] ?? ref)
  }
  if (Array.isArray(value)) return value.map((v) => resolveSecrets(v, secrets))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveSecrets(v, secrets)]),
    )
  }
  return value
}

/** Secret values in a result become `${secret:NAME}` before the AI reads it (FR-013). */
function maskSecrets(text: string, secrets: Readonly<Record<string, string>>): string {
  let masked = text
  for (const [name, value] of Object.entries(secrets)) {
    if (value.length >= 4) masked = masked.split(value).join(`\${secret:${name}}`)
  }
  return masked
}

const outcome = (ok: boolean, result: string, extra: Partial<ToolOutcome> = {}): ToolOutcome => ({
  ok,
  result,
  ...extra,
})
const refused = (error: 'not_allowed' | 'side_effects_disabled'): ToolOutcome =>
  outcome(false, JSON.stringify({ error }), { blocked: true, error })

/**
 * The MCP servers of one activity (research R5, D29): each remote server of `mcp.yaml` is reached
 * once, its tools listed, and only those the file allows are offered to the AI as
 * `<server>__<tool>` — a tool the server does not mark read-only only with `side_effects: true`,
 * a server with `roles` only to those roles. Every call is checked again (the AI may invent a
 * name), given 20 s, and its result cut at 8 KB with secret values masked.
 */
export async function openMcp(options: McpSessionOptions): Promise<McpSession> {
  const connect = options.connect ?? httpConnect
  const timeoutMs = options.timeoutMs ?? MCP_TIMEOUT_MS
  const servers = new Map<
    string,
    { connection: McpConnection; tools: Map<string, McpListedTool> }
  >()
  for (const [name, server] of Object.entries(options.config.servers)) {
    // Local (stdio) servers are not run in Phase 3 (research R5).
    if (!server.url) continue
    try {
      const headers = Object.fromEntries(
        Object.entries(server.headers).map(([k, v]) => [
          k,
          resolveSecrets(v, options.secrets) as string,
        ]),
      )
      const connection = await connect({ name, url: server.url, headers })
      const listed = await connection.listTools()
      servers.set(name, { connection, tools: new Map(listed.map((t) => [t.name, t])) })
    } catch (error) {
      options.onError?.(name, error)
    }
  }

  /** Why `role` may not call `server__tool`; undefined when it may. */
  function refusal(role: BrainRole, server: string, tool: string) {
    const declared = options.config.servers[server]
    const entry = declared?.tools[tool]
    const listed = servers.get(server)?.tools.get(tool)
    if (!declared || !entry || !listed) return 'not_allowed' as const
    if (declared.roles && !declared.roles.includes(role)) return 'not_allowed' as const
    if (!listed.readOnly && !entry.side_effects) return 'side_effects_disabled' as const
    return undefined
  }

  return {
    toolsFor(role) {
      const specs: ToolSpec[] = []
      for (const [server, { tools }] of servers) {
        for (const tool of tools.values()) {
          if (refusal(role, server, tool.name)) continue
          specs.push({
            name: `${server}${MCP_SEPARATOR}${tool.name}`,
            description: tool.description ?? tool.name,
            inputSchema: tool.inputSchema,
          })
        }
      }
      return {
        specs,
        async call(name, args) {
          const at = name.indexOf(MCP_SEPARATOR)
          const server = at > 0 ? name.slice(0, at) : ''
          const tool = at > 0 ? name.slice(at + MCP_SEPARATOR.length) : ''
          const why = refusal(role, server, tool)
          if (why) return refused(why)
          const connection = servers.get(server)?.connection
          if (!connection) return refused('not_allowed')
          const started = performance.now()
          const latencyMs = () => Math.round(performance.now() - started)
          try {
            const result = await connection.callTool(
              tool,
              resolveSecrets(args, options.secrets),
              timeoutMs,
            )
            const text = maskSecrets(result.text, options.secrets).slice(0, MAX_TOOL_RESULT)
            return result.isError
              ? outcome(false, text, { error: 'server_error', latencyMs: latencyMs() })
              : outcome(true, text, { latencyMs: latencyMs() })
          } catch (error) {
            const timedOut = /timed? ?out/i.test(String((error as Error | undefined)?.message))
            return outcome(
              false,
              JSON.stringify({ error: timedOut ? 'timeout' : 'server_error' }),
              {
                error: timedOut ? 'timeout' : 'server_error',
                latencyMs: latencyMs(),
              },
            )
          }
        },
      }
    },
    async close() {
      await Promise.allSettled([...servers.values()].map((s) => s.connection.close()))
      servers.clear()
    },
  }
}
