import { describe, expect, it } from 'vitest'
import { loadConfig } from './config'

describe('loadConfig', () => {
  it('uses development defaults', () => {
    expect(loadConfig({})).toEqual({
      serverUrl: 'http://localhost:3000',
      pollMs: 15_000,
      logLevel: 'info',
    })
  })

  it('reads values from the environment', () => {
    expect(
      loadConfig({ CORAL_SERVER_URL: 'https://coral.example.com', CORAL_AGENT_POLL_MS: '5000' }),
    ).toMatchObject({ serverUrl: 'https://coral.example.com', pollMs: 5000 })
  })

  it('rejects invalid values', () => {
    expect(() => loadConfig({ CORAL_SERVER_URL: 'not a url' })).toThrow(/CORAL_SERVER_URL/)
    expect(() => loadConfig({ CORAL_SERVER_URL: 'ftp://coral.example.com' })).toThrow(
      /CORAL_SERVER_URL/,
    )
    expect(() => loadConfig({ CORAL_AGENT_POLL_MS: '10' })).toThrow(/CORAL_AGENT_POLL_MS/)
  })
})
