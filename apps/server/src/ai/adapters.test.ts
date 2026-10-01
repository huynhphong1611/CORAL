import { describe, expect, it } from 'vitest'
import { providerAdapters } from './adapters'

describe('provider adapters of the server (T021, T022)', () => {
  it.each(['claude', 'gemini'] as const)('builds the %s adapter from a key, none without', (id) => {
    const factory = providerAdapters()[id]
    expect(factory?.('key-test')).toMatchObject({ id, vision: true })
    expect(factory?.(undefined)).toBeUndefined()
  })
})
