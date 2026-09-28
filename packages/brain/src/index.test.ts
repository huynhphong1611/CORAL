import { describe, expect, it } from 'vitest'
import { BRAIN_PROVIDERS, isBrainProvider } from './index'

describe('brain providers', () => {
  it('lists the three providers from SPEC §14.2', () => {
    expect(BRAIN_PROVIDERS).toEqual(['claude', 'gemini', 'copilot'])
  })

  it('recognises provider ids', () => {
    expect(isBrainProvider('gemini')).toBe(true)
    expect(isBrainProvider('gpt')).toBe(false)
  })
})
