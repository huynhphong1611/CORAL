import { LOG_LEVELS, type LogLevel } from '@coral/shared'
import { z } from 'zod'

const envSchema = z.object({
  CORAL_SERVER_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:3000'),
  CORAL_AGENT_POLL_MS: z.coerce.number().int().min(1000).default(15_000),
  CORAL_LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
})

export interface AgentConfig {
  serverUrl: string
  pollMs: number
  logLevel: LogLevel
}

/** Reads agent settings from the environment; throws with every problem listed. */
export function loadConfig(env: Record<string, string | undefined>): AgentConfig {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    throw new Error(`Invalid coral-agent configuration:\n${z.prettifyError(parsed.error)}`)
  }
  return {
    serverUrl: parsed.data.CORAL_SERVER_URL,
    pollMs: parsed.data.CORAL_AGENT_POLL_MS,
    logLevel: parsed.data.CORAL_LOG_LEVEL,
  }
}
