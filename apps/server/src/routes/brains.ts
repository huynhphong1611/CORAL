import { api, toYaml, type ValidationIssue } from '@coral/shared'
import type { FastifyInstance } from 'fastify'
import type { BrainsSettings } from '../ai/brains-config'
import { ADMIN_ROLES } from '../auth/guard'
import { HttpError, parseInput } from '../http/errors'
import type { Repos } from '../repos'
import { scope } from './context'

/** Longest brains.yaml accepted (it is a page of settings). */
const MAX_YAML_BYTES = 256 * 1024
const YAML_TYPES = ['application/yaml', 'application/x-yaml', 'text/yaml']

const toDetail = (issue: ValidationIssue) => ({
  path: issue.path,
  code: issue.code,
  message: issue.message,
  ...(issue.line === undefined ? {} : { line: issue.line }),
  ...(issue.column === undefined ? {} : { column: issue.column }),
})

/**
 * The tenant's AI brains (contracts/rest-api-phase3.md, US1): the config in force and where it
 * comes from, replacing it (owner/admin, audited; checked like `coral validate`, FR-004), and
 * what the AI cost by day, role or provider against today's limit (FR-010).
 */
export function registerBrainRoutes(
  app: FastifyInstance,
  deps: { repos: Repos; settings: BrainsSettings },
): void {
  // A brains.yaml can be sent as it is written.
  app.addContentTypeParser(
    YAML_TYPES,
    { parseAs: 'string', bodyLimit: MAX_YAML_BYTES },
    (_request, body, done) => done(null, body),
  )

  async function view(request: Parameters<typeof scope>[1]): Promise<api.BrainsConfigView> {
    const resolved = await deps.settings.resolve(scope(deps.repos, request))
    return { ...resolved, providers: deps.settings.providerList() }
  }

  app.get('/brains/config', async (request, reply) => {
    const current = await view(request)
    if (request.headers.accept?.includes('application/yaml')) {
      return reply.type('application/yaml; charset=utf-8').send(current.yaml)
    }
    return current
  })

  app.put('/brains/config', { config: { roles: ADMIN_ROLES } }, async (request) => {
    const s = scope(deps.repos, request)
    const yaml =
      typeof request.body === 'string'
        ? request.body
        : request.body !== null && typeof request.body === 'object'
          ? toYaml(request.body)
          : ''
    if (yaml.trim() === '') {
      throw new HttpError(400, 'validation_failed', 'empty brains config', [
        { path: '', code: 'schema', message: 'send a coral/brains@1 document as YAML or JSON' },
      ])
    }
    const checked = deps.settings.validate(yaml)
    if (!checked.valid || !checked.value) {
      throw new HttpError(
        400,
        'validation_failed',
        'brains config is not valid',
        checked.errors.map(toDetail),
      )
    }
    await s.settings.setBrains({
      yaml,
      config: checked.value,
      updated_at: new Date().toISOString(),
      updated_by: s.auth.userId,
    })
    await s.audit({ actor: `user:${s.auth.userId}`, action: 'brains.config.update' })
    return view(request)
  })

  app.get('/usage/ai', async (request) => {
    const query = parseInput(api.usageQuerySchema, request.query)
    const s = scope(deps.repos, request)
    const [rows, today, resolved] = await Promise.all([
      s.brainCalls.usage(query),
      s.brainCalls.costOfDay(),
      deps.settings.resolve(s),
    ])
    return {
      rows,
      total_cost_usd: rows.reduce((sum, row) => sum + row.cost_usd, 0),
      today: {
        cost_usd: today,
        limit_usd: resolved.config?.limits.max_cost_usd_per_day ?? null,
      },
    } satisfies api.Usage
  })
}
