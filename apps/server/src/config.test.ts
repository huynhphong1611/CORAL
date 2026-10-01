import { existsSync } from 'node:fs'
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { DEFAULT_AI_PRICES, DEV_JWT_SECRET, loadConfig } from './config'

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

  it('has AI settings off by default (Phase 3)', () => {
    expect(loadConfig({}).ai).toEqual({
      fakeBrains: false,
      pricesPath: DEFAULT_AI_PRICES,
      keys: {},
      copilotEnabled: false,
      mcpStdioAllowlist: [],
      maxExplorations: 5,
    })
    expect(existsSync(DEFAULT_AI_PRICES)).toBe(true)
  })

  it('reads the AI settings', () => {
    const config = loadConfig({
      CORAL_BRAIN_FAKE: 'true',
      CORAL_BRAINS_DEFAULT: 'examples/brains.fake.yaml',
      CORAL_COPILOT_ENABLED: '1',
      CORAL_MCP_STDIO_ALLOWLIST: 'playwright-mcp, other ,',
      CORAL_MAX_EXPLORATIONS: '2',
      CORAL_ANTHROPIC_API_KEY: 'sk-ant-secret-value',
    })
    expect(config.ai).toMatchObject({
      fakeBrains: true,
      brainsDefaultPath: 'examples/brains.fake.yaml',
      copilotEnabled: true,
      mcpStdioAllowlist: ['playwright-mcp', 'other'],
      maxExplorations: 2,
    })
    expect(config.ai.keys.anthropic).toBe('sk-ant-secret-value')
    expect(() => loadConfig({ CORAL_BRAIN_FAKE: 'maybe' })).toThrow(/CORAL_BRAIN_FAKE/)
    expect(() => loadConfig({ CORAL_MAX_EXPLORATIONS: '0' })).toThrow(/CORAL_MAX_EXPLORATIONS/)
  })

  it('never prints a provider key (FR-008)', () => {
    const config = loadConfig({ CORAL_GEMINI_API_KEY: 'gemini-secret-value' })
    expect(JSON.stringify(config)).not.toContain('gemini-secret-value')
    expect(inspect(config, { depth: 5 })).not.toContain('gemini-secret-value')
    expect(String(config.ai.keys)).not.toContain('gemini-secret-value')
  })
})
