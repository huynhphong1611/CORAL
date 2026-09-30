/**
 * Brain layer (SPEC §14). Phase 0 ships only the package skeleton; the `Brain` interface,
 * the claude / gemini / copilot adapters and the role router arrive in Phase 3.
 *
 * This is the ONLY package allowed to depend on LLM SDKs, and only apps/server may
 * depend on it (SPEC P1, D08 — enforced by `pnpm check:boundaries`).
 */

/** Provider ids accepted in brains.yaml (SPEC §14.2, §14.3). */
export const BRAIN_PROVIDERS = ['claude', 'gemini', 'copilot'] as const

export type BrainProviderId = (typeof BRAIN_PROVIDERS)[number]

export function isBrainProvider(value: string): value is BrainProviderId {
  return (BRAIN_PROVIDERS as readonly string[]).includes(value)
}
