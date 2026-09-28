import { homedir } from 'node:os'
import { join } from 'node:path'
import { LOG_LEVELS, type LogLevel } from '@coral/shared'
import { z } from 'zod'

const envSchema = z.object({
  CORAL_SERVER_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:3000'),
  CORAL_AGENT_TOKEN: z
    .string()
    .regex(/^coral_agt_[A-Za-z0-9_-]{20,}$/, 'must look like coral_agt_…')
    .optional(),
  CORAL_AGENT_POLL_MS: z.coerce.number().int().min(1000).default(15_000),
  CORAL_ADB: z.string().min(1).default('adb'),
  CORAL_U2_JAR: z.string().min(1).optional(),
  CORAL_CACHE_DIR: z.string().min(1).optional(),
  CORAL_LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
})

export interface AgentConfig {
  serverUrl: string
  /** WebSocket endpoint derived from serverUrl (http → ws, https → wss). */
  wsUrl: string
  agentToken?: string
  pollMs: number
  adbPath: string
  u2JarPath?: string
  cacheDir: string
  logLevel: LogLevel
}

/** Reads agent settings from the environment; throws with every problem listed. */
export function loadConfig(env: Record<string, string | undefined>): AgentConfig {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    throw new Error(`Invalid coral-agent configuration:\n${z.prettifyError(parsed.error)}`)
  }
  const e = parsed.data
  const ws = new URL('/ws/agent', e.CORAL_SERVER_URL)
  ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:'
  return {
    serverUrl: e.CORAL_SERVER_URL,
    wsUrl: ws.toString(),
    agentToken: e.CORAL_AGENT_TOKEN,
    pollMs: e.CORAL_AGENT_POLL_MS,
    adbPath: e.CORAL_ADB,
    u2JarPath: e.CORAL_U2_JAR,
    cacheDir: e.CORAL_CACHE_DIR ?? join(homedir(), '.cache', 'coral'),
    logLevel: e.CORAL_LOG_LEVEL,
  }
}
