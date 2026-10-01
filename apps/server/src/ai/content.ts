import { api, referenceSecrets } from '@coral/shared'
import type { ArtifactStore } from '../storage/s3'

/** What an AI call sent and answered is kept this long (FR-006a). */
export const AI_CONTENT_RETENTION_DAYS = 30

/** `<tenant>/ai/<ref_type>/<ref_id>/<brain_call_id>.json` (data-model §5). */
export function aiContentKey(
  tenantId: string,
  refType: api.BrainCallRefType,
  refId: string,
  brainCallId: string,
): string {
  return `${tenantId}/ai/${refType}/${refId}/${brainCallId}.json`
}

/**
 * Stores and reads the content of AI calls in object storage with the 30-day retention tag.
 * Secret values become `${secret:NAME}` before anything is written (FR-013).
 */
export class AiContentStore {
  constructor(private readonly artifacts: ArtifactStore) {}

  async put(
    key: string,
    content: api.BrainCallContent,
    secrets: Readonly<Record<string, string>>,
  ): Promise<void> {
    const masked = referenceSecrets(content, secrets)
    await this.artifacts.putBytes(
      key,
      new TextEncoder().encode(JSON.stringify(masked)),
      'application/json',
      { runArtifact: true },
    )
  }

  /** The content, or null once it expired or was never stored. */
  async get(key: string): Promise<api.BrainCallContent | null> {
    const bytes = await this.artifacts.getBytes(key)
    if (!bytes) return null
    const parsed = api.brainCallContentSchema.safeParse(
      JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    )
    return parsed.success ? parsed.data : null
  }
}
