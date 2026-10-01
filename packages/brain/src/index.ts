/**
 * Brain layer (SPEC §14, contracts/brain.md): the `Brain` interface, provider-neutral prompts,
 * the structured-answer loop and the provider adapters.
 *
 * This is the ONLY package allowed to depend on LLM and MCP SDKs, and only apps/server may
 * depend on it (SPEC P1, D08 — enforced by `pnpm check:boundaries`). The SDKs stay inside their
 * adapter files: this entry point imports none of them.
 */
export * from './brain'
export * from './prompts'
export * from './structured'
export { createFakeAdapter, type FakeScript } from './adapters/fake'
