/**
 * Deterministic runner shared by coral-agent and `coral run` (SPEC §8, D09).
 * No AI here: this package must never depend on @coral/brain or an LLM SDK (SPEC P1, D08).
 */
export const RUNNER_PACKAGE = '@coral/runner'
