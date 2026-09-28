import { healthResponseSchema, type HealthResponse } from '@coral/shared'

/**
 * Checks that coral-server is reachable. Phase 0 only; the WebSocket protocol of
 * SPEC §15 replaces this probe in Phase 1.
 */
export async function fetchServerHealth(
  serverUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<HealthResponse> {
  const response = await fetchImpl(new URL('/health', serverUrl), {
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    throw new Error(`GET /health returned HTTP ${response.status}`)
  }
  return healthResponseSchema.parse(await response.json())
}
