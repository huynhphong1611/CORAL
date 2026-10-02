import type { CallRecord } from '@coral/brain'
import { newId, referenceSecrets } from '@coral/shared'
import type { FastifyBaseLogger } from 'fastify'
import type { TenantRepos } from '../repos'
import { aiContentKey, type AiContentStore } from './content'

/**
 * The router's `record` callback (research R4): one `brain_calls` row per attempt, its content
 * in object storage (secrets masked) and the tool calls it made. `lastCallId()` is the call that
 * answered last — the exploration step links to it.
 */
export function callRecorder(deps: {
  tenantId: string
  repos: Pick<TenantRepos, 'brainCalls'>
  content: AiContentStore
  /** Secret values to mask, name → value. */
  secrets: () => Readonly<Record<string, string>>
  log?: FastifyBaseLogger
}) {
  let last: string | undefined

  async function record(call: CallRecord): Promise<void> {
    const id = newId()
    const secrets = deps.secrets()
    const key = aiContentKey(deps.tenantId, call.ref.type, call.ref.id, id)
    let contentKey: string | null = key
    try {
      await deps.content.put(key, call.content, secrets)
    } catch (error) {
      // The call is still counted: cost limits must hold even when storage is down.
      contentKey = null
      deps.log?.warn({ err: error, brainCallId: id }, 'AI call content not stored')
    }
    await deps.repos.brainCalls.record({
      id,
      role: call.role,
      provider: call.provider,
      model: call.model,
      attempt: call.attempt,
      tokensIn: call.usage.input + call.usage.cachedInput,
      tokensOut: call.usage.output,
      tokensCached: call.usage.cachedInput,
      costUsd: call.costUsd,
      latencyMs: Math.round(call.latencyMs),
      ok: call.ok,
      error: call.error ?? null,
      refType: call.ref.type,
      refId: call.ref.id,
      contentKey,
    })
    for (const tool of call.toolCalls) {
      const [server, name] = tool.name.includes('__')
        ? [
            tool.name.slice(0, tool.name.indexOf('__')),
            tool.name.slice(tool.name.indexOf('__') + 2),
          ]
        : ['coral', tool.name]
      await deps.repos.brainCalls.recordTool({
        brainCallId: id,
        mcpServer: server,
        tool: name,
        argsRedacted: referenceSecrets(tool.args ?? {}, secrets),
        ok: tool.outcome.ok,
        blocked: tool.outcome.blocked ?? false,
        error: tool.outcome.error ?? null,
        latencyMs: Math.round(tool.outcome.latencyMs ?? 0),
      })
    }
    if (call.ok) last = id
  }

  return { record, lastCallId: () => last }
}
