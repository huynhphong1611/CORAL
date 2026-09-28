import { LOG_LEVELS, type LogLevel } from '@coral/shared'
import { z } from 'zod'

const envSchema = z.object({
  CORAL_SERVER_HOST: z.string().min(1).default('0.0.0.0'),
  CORAL_SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CORAL_LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
})

export interface ServerConfig {
  host: string
  port: number
  logLevel: LogLevel
}

/** Reads server settings from the environment; throws with every problem listed. */
export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    throw new Error(`Invalid coral-server configuration:\n${z.prettifyError(parsed.error)}`)
  }
  return {
    host: parsed.data.CORAL_SERVER_HOST,
    port: parsed.data.CORAL_SERVER_PORT,
    logLevel: parsed.data.CORAL_LOG_LEVEL,
  }
}
