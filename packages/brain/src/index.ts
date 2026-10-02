/**
 * Brain layer (SPEC §14, contracts/brain.md): the `Brain` interface, provider-neutral prompts,
 * the structured-answer loop and the provider adapters.
 *
 * This is the ONLY package allowed to depend on LLM and MCP SDKs, and only apps/server may
 * depend on it (SPEC P1, D08 — enforced by `pnpm check:boundaries`). Each LLM SDK is used in its own
 * adapter file only, the MCP SDK in tools/mcp.ts (and the fake MCP server of `@coral/brain/testing`);
 * the rest of the layer is provider-neutral.
 */
export * from './brain'
export * from './prompts'
export * from './structured'
export { createClaudeAdapter, type ClaudeAdapterOptions } from './adapters/claude'
export {
  createCopilotAdapter,
  stopCopilotRuntime,
  type CopilotAdapterOptions,
} from './adapters/copilot'
export { createFakeAdapter, type FakeScript } from './adapters/fake'
export { createGeminiAdapter, type GeminiAdapterOptions } from './adapters/gemini'
export * from './router'
export * from './tools/mcp'
export * from './tools/skills'
