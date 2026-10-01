import { createClaudeAdapter, createGeminiAdapter } from '@coral/brain'
import type { BrainProviderId } from '@coral/shared'
import type { AdapterFactory } from './service'

/**
 * The real providers this server can call (research R2). Each adapter is built per activity from
 * the key the tenant's brains config resolves to; no key → the provider is not available and the
 * router falls back.
 */
export function providerAdapters(): Partial<Record<BrainProviderId, AdapterFactory>> {
  return {
    claude: (key) => (key ? createClaudeAdapter({ apiKey: key }) : undefined),
    gemini: (key) => (key ? createGeminiAdapter({ apiKey: key }) : undefined),
  }
}
