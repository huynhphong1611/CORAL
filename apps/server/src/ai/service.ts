import {
  createBrain,
  createFakeAdapter,
  skillTools,
  type Brain,
  type BrainCallRole,
  type CallContext,
  type ProviderAdapter,
} from '@coral/brain'
import type { BrainProviderId, BrainsConfig, api } from '@coral/shared'
import type { FastifyBaseLogger } from 'fastify'
import type { ProjectRepoStore } from '../git/project-repo-store'
import { HttpError } from '../http/errors'
import type { Repos } from '../repos'
import type { SecretSource } from '../runs/secrets'
import type { ArtifactStore } from '../storage/s3'
import type { BrainsSettings } from './brains-config'
import { AiContentStore } from './content'
import { loadKnowledge, type LoadedKnowledge } from './knowledge'
import { callRecorder } from './usage'

/** Builds the adapter of a provider from its key; undefined when it cannot run here. */
export type AdapterFactory = (key: string | undefined) => ProviderAdapter | undefined

/** Everything an activity (exploration, import job) needs to ask the AI of one project. */
export interface ProjectBrain {
  brain: Brain
  config: BrainsConfig
  loaded: LoadedKnowledge
  /** The context of a call for `role`, scoped to this project and activity. */
  context(role: BrainCallRole): CallContext
  /** The brain call that answered last (an exploration step links to it). */
  lastCallId(): string | undefined
}

/**
 * The server side of the brain layer (T016): config source, prices, keys, knowledge of the
 * project being run, and the records of every call (`brain_calls`, content, `tool_calls`).
 */
export class AiService {
  readonly content: AiContentStore

  constructor(
    private readonly deps: {
      repos: Repos
      store: ProjectRepoStore
      artifacts: ArtifactStore
      settings: BrainsSettings
      secrets: SecretSource
      fakeBrains: boolean
      stdioAllowlist: readonly string[]
      /** The real providers (claude, gemini, copilot), built per call from the tenant's key. */
      adapters?: Partial<Record<BrainProviderId, AdapterFactory>>
      log?: FastifyBaseLogger
    },
  ) {
    this.content = new AiContentStore(deps.artifacts)
  }

  /** Every secret value of the server, name → value (dev: `CORAL_SECRET_*`, D19). */
  secretValues(): Record<string, string> {
    return this.deps.secrets.get(this.deps.secrets.names())
  }

  private adaptersFor(config: BrainsConfig): Partial<Record<string, ProviderAdapter>> {
    const adapters: Partial<Record<string, ProviderAdapter>> = {}
    if (this.deps.fakeBrains) {
      adapters.fake = createFakeAdapter('fake')
      adapters['fake-alt'] = createFakeAdapter('fake-alt')
    }
    for (const [id, factory] of Object.entries(this.deps.adapters ?? {})) {
      // A provider the tenant turned off is never called, fallback included (FR-009).
      if (config.providers[id]?.enabled === false) continue
      const adapter = factory?.(this.deps.settings.apiKey(config, id))
      if (adapter) adapters[id] = adapter
    }
    return adapters
  }

  /**
   * Whether an activity may start (contracts/rest-api-phase3.md `POST /explorations`): the
   * tenant's brains config, else 409 `brains_not_configured`; 409 `daily_limit_reached` when
   * today's AI cost already reached `limits.max_cost_usd_per_day`.
   */
  async ready(tenantId: string): Promise<BrainsConfig> {
    const repos = this.deps.repos.tenant(tenantId)
    const { config } = await this.deps.settings.resolve(repos)
    if (!config) {
      throw new HttpError(409, 'brains_not_configured', 'AI is not configured for this tenant')
    }
    if ((await repos.brainCalls.costOfDay()) >= config.limits.max_cost_usd_per_day) {
      throw new HttpError(409, 'daily_limit_reached', 'the AI cost of today reached its limit')
    }
    return config
  }

  /**
   * The brain of one project for one activity; 409 `brains_not_configured` when the tenant has
   * no config and the platform no default (contracts/brains-yaml.md).
   */
  async projectBrain(input: {
    tenantId: string
    projectId: string
    ref: { type: api.BrainCallRefType; id: string }
    maxCostUsd: number
    commit?: string
  }): Promise<ProjectBrain> {
    const repos = this.deps.repos.tenant(input.tenantId)
    const resolved = await this.deps.settings.resolve(repos)
    if (!resolved.config) {
      throw new HttpError(409, 'brains_not_configured', 'AI is not configured for this tenant')
    }
    const config = resolved.config
    await repos.projects.get(input.projectId)
    const loaded = await loadKnowledge(this.deps.store, input.tenantId, input.projectId, {
      stdioAllowlist: this.deps.stdioAllowlist,
      ...(input.commit ? { commit: input.commit } : {}),
    })
    const recorder = callRecorder({
      tenantId: input.tenantId,
      repos,
      content: this.content,
      secrets: () => this.secretValues(),
      ...(this.deps.log ? { log: this.deps.log } : {}),
    })
    const tools = skillTools(loaded.skillBodies)
    const brain = createBrain({
      config,
      adapters: this.adaptersFor(config),
      price: (model) => this.deps.settings.price(config, model),
      dailySpentUsd: () => repos.brainCalls.costOfDay(),
      record: recorder.record,
    })
    return {
      brain,
      config,
      loaded,
      lastCallId: recorder.lastCallId,
      context: (role) => ({
        tenantId: input.tenantId,
        role,
        ref: input.ref,
        budget: {
          maxCostUsd: input.maxCostUsd,
          spentUsd: () => repos.brainCalls.costOf(input.ref.type, input.ref.id),
        },
        knowledge: loaded.knowledge,
        // read_skill over this project's skills; the MCP allowlist joins here in US7.
        tools,
      }),
    }
  }
}
