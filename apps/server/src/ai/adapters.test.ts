import { describe, expect, it } from 'vitest'
import { providerAdapters } from './adapters'

describe('provider adapters of the server (T021, T022, T026)', () => {
  it.each(['claude', 'gemini'] as const)('builds the %s adapter from a key, none without', (id) => {
    const factory = providerAdapters()[id]
    expect(factory?.('key-test')).toMatchObject({ id, vision: true })
    expect(factory?.(undefined)).toBeUndefined()
  })

  it('offers copilot only when the platform turned it on (FR-009)', () => {
    expect(providerAdapters().copilot).toBeUndefined()
    const copilot = providerAdapters({ copilotEnabled: true }).copilot
    expect(copilot?.('ghu_token')).toMatchObject({ id: 'copilot', vision: true, runsTools: true })
    expect(copilot?.(undefined)).toBeUndefined()
  })
})
