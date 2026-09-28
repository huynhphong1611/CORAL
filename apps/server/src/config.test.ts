import { describe, expect, it } from 'vitest'
import { loadConfig } from './config'

describe('loadConfig', () => {
  it('uses development defaults', () => {
    expect(loadConfig({})).toEqual({ host: '0.0.0.0', port: 3000, logLevel: 'info' })
  })

  it('reads values from the environment', () => {
    expect(
      loadConfig({
        CORAL_SERVER_HOST: '127.0.0.1',
        CORAL_SERVER_PORT: '8080',
        CORAL_LOG_LEVEL: 'debug',
      }),
    ).toEqual({ host: '127.0.0.1', port: 8080, logLevel: 'debug' })
  })

  it('rejects invalid values', () => {
    expect(() => loadConfig({ CORAL_SERVER_PORT: '70000' })).toThrow(/CORAL_SERVER_PORT/)
    expect(() => loadConfig({ CORAL_LOG_LEVEL: 'loud' })).toThrow(/CORAL_LOG_LEVEL/)
  })
})
