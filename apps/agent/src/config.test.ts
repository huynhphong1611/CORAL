import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from './config'

describe('loadConfig', () => {
  it('uses development defaults', () => {
    expect(loadConfig({})).toEqual({
      serverUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3000/ws/agent',
      agentToken: undefined,
      pollMs: 15_000,
      adbPath: 'adb',
      u2JarPath: undefined,
      cacheDir: join(homedir(), '.cache', 'coral'),
      logLevel: 'info',
    })
  })

  it('derives wss:// from https:// and reads the agent settings', () => {
    const token = `coral_agt_${'a'.repeat(43)}`
    expect(
      loadConfig({
        CORAL_SERVER_URL: 'https://coral.example.com',
        CORAL_AGENT_TOKEN: token,
        CORAL_ADB: '/opt/android/platform-tools/adb',
        CORAL_U2_JAR: '/opt/coral/u2.jar',
        CORAL_CACHE_DIR: '/var/cache/coral',
      }),
    ).toMatchObject({
      wsUrl: 'wss://coral.example.com/ws/agent',
      agentToken: token,
      adbPath: '/opt/android/platform-tools/adb',
      u2JarPath: '/opt/coral/u2.jar',
      cacheDir: '/var/cache/coral',
    })
  })

  it('rejects invalid values', () => {
    expect(() => loadConfig({ CORAL_SERVER_URL: 'not a url' })).toThrow(/CORAL_SERVER_URL/)
    expect(() => loadConfig({ CORAL_SERVER_URL: 'ftp://coral.example.com' })).toThrow(
      /CORAL_SERVER_URL/,
    )
    expect(() => loadConfig({ CORAL_AGENT_POLL_MS: '10' })).toThrow(/CORAL_AGENT_POLL_MS/)
    expect(() => loadConfig({ CORAL_AGENT_TOKEN: 'abc' })).toThrow(/CORAL_AGENT_TOKEN/)
  })
})
