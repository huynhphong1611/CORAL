import { api } from '@coral/shared'
import type { FastifyInstance } from 'fastify'
import { AiContentStore } from '../ai/content'
import { parseInput } from '../http/errors'
import type { Repos } from '../repos'
import { keyBelongsTo } from '../storage/keys'
import type { ArtifactStore } from '../storage/s3'
import { scope } from './context'

/**
 * One AI call as the trace shows it (contracts/rest-api-phase3.md, FR-006a): tokens, cost, what was
 * sent and answered — `content` is null once its 30 days are over — and the tools it called.
 * Pictures in the content become presigned URLs, only for objects of the caller's tenant.
 */
export function registerBrainCallRoutes(
  app: FastifyInstance,
  deps: { repos: Repos; artifacts: ArtifactStore },
): void {
  const content = new AiContentStore(deps.artifacts)

  app.get('/brain-calls/:id', async (request) => {
    const { id } = parseInput(api.idParamsSchema, request.params)
    const { brainCalls, auth } = scope(deps.repos, request)
    const row = await brainCalls.get(id)
    const stored = row.contentKey ? await content.get(row.contentKey) : null
    const messages = stored
      ? await Promise.all(
          stored.messages.map(async ({ image, ...message }) =>
            image && keyBelongsTo(image, auth.tenantId)
              ? { ...message, image: (await deps.artifacts.presignGet(image)).url }
              : message,
          ),
        )
      : []
    const tools = await brainCalls.toolCalls([id])
    return {
      id: row.id,
      role: row.role,
      provider: api.brainCallSchema.shape.provider.parse(row.provider),
      model: row.model,
      attempt: row.attempt,
      ok: row.ok,
      error: row.error,
      tokens_in: row.tokensIn,
      tokens_out: row.tokensOut,
      cost_usd: row.costUsd,
      latency_ms: row.latencyMs,
      created_at: row.createdAt.toISOString(),
      content: stored ? { ...stored, messages } : null,
      tool_calls: tools.map((tool) => ({
        id: tool.id,
        mcp_server: tool.mcpServer,
        tool: tool.tool,
        args_redacted: tool.argsRedacted,
        ok: tool.ok,
        blocked: tool.blocked,
        error: tool.error,
        latency_ms: tool.latencyMs,
        created_at: tool.createdAt.toISOString(),
      })),
    } satisfies api.BrainCall
  })
}
