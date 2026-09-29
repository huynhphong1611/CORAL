import { LOG_LEVELS, type LogLevel } from '@coral/shared'
import { z } from 'zod'

/** Development-only JWT key; refused when NODE_ENV=production. */
export const DEV_JWT_SECRET = 'coral-dev-jwt-secret-do-not-use-in-production'

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  CORAL_SERVER_HOST: z.string().min(1).default('0.0.0.0'),
  CORAL_SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CORAL_LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  DATABASE_URL: z
    .url({ protocol: /^postgres(ql)?$/ })
    .default('postgres://coral:coral@localhost:5432/coral'),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }).default('redis://localhost:6379'),
  S3_ENDPOINT: z.url({ protocol: /^https?$/ }).default('http://localhost:9000'),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(3).default('coral-artifacts'),
  S3_ACCESS_KEY_ID: z.string().min(1).default('coral'),
  S3_SECRET_ACCESS_KEY: z.string().min(1).default('coral-dev-secret'),
  CORAL_DATA_DIR: z.string().min(1).default('./data'),
  CORAL_MAX_BUILD_MB: z.coerce.number().int().min(1).max(4096).default(500),
  CORAL_JWT_SECRET: z.string().min(32, 'must be at least 32 characters').optional(),
  CORAL_SEED_EMAIL: z.email().optional(),
  CORAL_SEED_PASSWORD: z.string().min(8).optional(),
  CORAL_HEARTBEAT_MS: z.coerce.number().int().min(100).default(15_000),
  CORAL_QUEUE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(600_000),
  CORAL_RUN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(1_800_000),
  /** A live control session ends after this long without a command (research R7). */
  CORAL_LIVE_IDLE_MS: z.coerce.number().int().min(1000).default(600_000),
})

export interface ServerConfig {
  host: string
  port: number
  logLevel: LogLevel
  databaseUrl: string
  redisUrl: string
  s3: {
    endpoint: string
    region: string
    bucket: string
    accessKeyId: string
    secretAccessKey: string
  }
  dataDir: string
  maxBuildBytes: number
  jwtSecret: string
  seed: { email?: string; password?: string }
  timeouts: {
    heartbeatMs: number
    queueTimeoutMs: number
    runTimeoutMs: number
    liveIdleMs: number
  }
}

/** Reads server settings from the environment; throws with every problem listed. */
export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    throw new Error(`Invalid coral-server configuration:\n${z.prettifyError(parsed.error)}`)
  }
  const e = parsed.data
  if (!e.CORAL_JWT_SECRET && e.NODE_ENV === 'production') {
    throw new Error(
      'Invalid coral-server configuration:\n✖ CORAL_JWT_SECRET is required in production',
    )
  }
  return {
    host: e.CORAL_SERVER_HOST,
    port: e.CORAL_SERVER_PORT,
    logLevel: e.CORAL_LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    s3: {
      endpoint: e.S3_ENDPOINT,
      region: e.S3_REGION,
      bucket: e.S3_BUCKET,
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
    },
    dataDir: e.CORAL_DATA_DIR,
    maxBuildBytes: e.CORAL_MAX_BUILD_MB * 1024 * 1024,
    jwtSecret: e.CORAL_JWT_SECRET ?? DEV_JWT_SECRET,
    seed: { email: e.CORAL_SEED_EMAIL, password: e.CORAL_SEED_PASSWORD },
    timeouts: {
      heartbeatMs: e.CORAL_HEARTBEAT_MS,
      queueTimeoutMs: e.CORAL_QUEUE_TIMEOUT_MS,
      runTimeoutMs: e.CORAL_RUN_TIMEOUT_MS,
      liveIdleMs: e.CORAL_LIVE_IDLE_MS,
    },
  }
}
