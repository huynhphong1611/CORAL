import { describe, expect, it } from 'vitest'
import { DEV_JWT_SECRET, loadConfig } from './config'

describe('loadConfig', () => {
  it('uses development defaults that match .env.example and compose.yaml', () => {
    const config = loadConfig({})
    expect(config).toMatchObject({
      host: '0.0.0.0',
      port: 3000,
      logLevel: 'info',
      databaseUrl: 'postgres://coral:coral@localhost:5432/coral',
      redisUrl: 'redis://localhost:6379',
      s3: { endpoint: 'http://localhost:9000', bucket: 'coral-artifacts' },
      dataDir: './data',
      maxBuildBytes: 500 * 1024 * 1024,
      jwtSecret: DEV_JWT_SECRET,
      timeouts: { heartbeatMs: 15_000, queueTimeoutMs: 600_000, runTimeoutMs: 1_800_000 },
    })
  })

  it('reads values from the environment', () => {
    expect(
      loadConfig({
        CORAL_SERVER_HOST: '127.0.0.1',
        CORAL_SERVER_PORT: '8080',
        CORAL_LOG_LEVEL: 'debug',
        CORAL_JWT_SECRET: 'x'.repeat(32),
        CORAL_SEED_EMAIL: 'huynh@example.com',
      }),
    ).toMatchObject({
      host: '127.0.0.1',
      port: 8080,
      logLevel: 'debug',
      jwtSecret: 'x'.repeat(32),
      seed: { email: 'huynh@example.com' },
    })
  })

  it('rejects invalid values', () => {
    expect(() => loadConfig({ CORAL_SERVER_PORT: '70000' })).toThrow(/CORAL_SERVER_PORT/)
    expect(() => loadConfig({ CORAL_LOG_LEVEL: 'loud' })).toThrow(/CORAL_LOG_LEVEL/)
    expect(() => loadConfig({ DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/)
  })

  it('requires a strong JWT secret', () => {
    expect(() => loadConfig({ CORAL_JWT_SECRET: 'short' })).toThrow(/CORAL_JWT_SECRET/)
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/CORAL_JWT_SECRET is required/)
  })
})
