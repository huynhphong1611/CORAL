import { z } from 'zod'
import { BRAIN_ROLES } from '../brains/schema'
import { parseYaml } from '../testcase/parse'
import {
  schemaIssues,
  validateParsed,
  type CheckOutcome,
  type ValidationResult,
} from '../testcase/validate'

/**
 * `coral/mcp@1` — MCP servers and the tools the AI roles of a project may call (SPEC §14.5, D29,
 * contracts/project-knowledge.md). Tools not listed are never offered; a tool the server does not
 * mark read-only is offered only with `side_effects: true`. Credentials only as `${secret:NAME}`.
 */
export const MCP_SCHEMA_ID = 'coral/mcp@1'
export const MCP_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/
const SECRET_REF = /^\$\{secret:[A-Za-z_][A-Za-z0-9_]{0,63}\}$/
const HAS_SECRET_REF = /\$\{secret:[A-Za-z_][A-Za-z0-9_]{0,63}\}/

export const mcpToolSchema = z.strictObject({
  /** Allows a tool the MCP server does not declare read-only (write, delete, send, pay). */
  side_effects: z.boolean().default(false),
  /** Exposed to outside AI through coral's own MCP endpoint (Phase 6, D32). */
  expose: z.boolean().default(false),
})

export const mcpServerSchema = z
  .strictObject({
    url: z.url({ protocol: /^https?$/ }).optional(),
    command: z.string().trim().min(1).optional(),
    args: z.array(z.string()).default([]),
    headers: z.record(z.string().min(1), z.string()).default({}),
    roles: z.array(z.enum(BRAIN_ROLES)).optional(),
    tools: z.record(z.string().regex(TOOL_NAME_PATTERN, 'a tool name'), mcpToolSchema),
  })
  .refine((s) => (s.url === undefined) !== (s.command === undefined), {
    message: 'a server has either url (remote, HTTP) or command (local, stdio)',
  })
export type McpServerConfig = z.infer<typeof mcpServerSchema>

export const mcpConfigSchema = z.strictObject({
  schema: z.literal(MCP_SCHEMA_ID),
  servers: z.record(z.string().regex(MCP_NAME_PATTERN, 'server name: [a-z0-9_-]'), mcpServerSchema),
})
export type McpConfig = z.infer<typeof mcpConfigSchema>

export interface McpCheckOptions {
  /** Local (stdio) servers the platform allows by name; others are refused (§14.5). */
  stdioAllowlist?: readonly string[]
}

/** A header value that looks like a credential typed in clear: long, no secret reference. */
function looksInline(name: string, value: string): boolean {
  if (SECRET_REF.test(value.trim()) || HAS_SECRET_REF.test(value)) return false
  return (
    /authorization|token|key|secret|password|cookie/i.test(name) || /^bearer\s+\S{8,}/i.test(value)
  )
}

function checkMcp(value: unknown, options: McpCheckOptions): CheckOutcome<McpConfig> {
  const parsed = mcpConfigSchema.safeParse(value)
  if (!parsed.success) return { issues: schemaIssues(parsed.error) }
  const config = parsed.data
  const issues: CheckOutcome<McpConfig>['issues'] = []
  for (const [name, server] of Object.entries(config.servers)) {
    if (server.command !== undefined && !(options.stdioAllowlist ?? []).includes(name)) {
      issues.push({
        path: ['servers', name, 'command'],
        code: 'stdio_not_allowed',
        message: `local MCP server "${name}" is not on the platform's allowlist; use a remote url`,
      })
    }
    for (const [header, headerValue] of Object.entries(server.headers)) {
      if (looksInline(header, headerValue)) {
        issues.push({
          path: ['servers', name, 'headers', header],
          code: 'inline_credential',
          message: `header ${header} looks like a credential: use \${secret:NAME}`,
        })
      }
    }
  }
  return { value: config, issues }
}

export function validateMcpSource(
  source: string,
  file = 'mcp.yaml',
  options: McpCheckOptions = {},
): ValidationResult<McpConfig> {
  return validateParsed(parseYaml(source), file, (value) => checkMcp(value, options))
}
