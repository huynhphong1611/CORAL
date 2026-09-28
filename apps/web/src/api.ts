import { healthResponseSchema, type HealthResponse } from '@coral/shared'

/** Base path of coral-server as seen from the browser (proxied by Vite in development). */
export const API_BASE = '/api'

export async function fetchHealth(fetchImpl: typeof fetch = fetch): Promise<HealthResponse> {
  const response = await fetchImpl(`${API_BASE}/health`)
  if (!response.ok) {
    throw new Error(`GET /health returned HTTP ${response.status}`)
  }
  return healthResponseSchema.parse(await response.json())
}
