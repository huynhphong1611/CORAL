import { describe, expect, it } from 'vitest'
import { providerAdapters } from './adapters'

describe('provider adapters of the server (T021)', () => {
  it('builds the claude adapter from a key, and none without one', () => {
    const claude = providerAdapters().claude
    expect(claude?.('sk-test')).toMatchObject({ id: 'claude', vision: true })
    expect(claude?.(undefined)).toBeUndefined()
  })
})
