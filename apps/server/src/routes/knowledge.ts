import {
  api,
  skillHeader,
  validateMcpSource,
  validateSkillRulesSource,
  validateSkillSource,
  type ValidationIssue,
} from '@coral/shared'
import type { FastifyInstance } from 'fastify'
import { AGENTS_MD_PATH, MCP_PATH, SKILLS_DIR } from '../ai/knowledge'
import { ADMIN_ROLES } from '../auth/guard'
import { HttpError, notFound, parseInput } from '../http/errors'
import type { Repos } from '../repos'
import { gitAuthor, scope } from './context'

const projectParams = api.idParamsSchema

const toDetail = (issue: ValidationIssue) => ({
  path: issue.path,
  code: issue.code,
  message: issue.message,
  ...(issue.line === undefined ? {} : { line: issue.line }),
  ...(issue.column === undefined ? {} : { column: issue.column }),
})

/** 400 `validation_failed` with each problem at its line, like the YAML editor (Phase 2). */
const invalid = (file: string, errors: ValidationIssue[]) =>
  new HttpError(400, 'validation_failed', `${file} is not valid`, errors.map(toDetail))

const skillDir = (name: string) => `${SKILLS_DIR}/${name}`

/**
 * The project's knowledge (contracts/rest-api-phase3.md, US4, §13): `AGENTS.md`, skills with
 * their `rules.yaml`, and `mcp.yaml` — files of the project repo, each save one commit, checked
 * like the AI reads them. `mcp.yaml` names servers the AI may call: owner/admin only, audited.
 */
export function registerKnowledgeRoutes(
  app: FastifyInstance,
  deps: { repos: Repos; stdioAllowlist: readonly string[] },
): void {
  app.get('/projects/:id/agents-md', async (request) => {
    const { id } = parseInput(projectParams, request.params)
    const file = await scope(deps.repos, request).knowledge.read(id, AGENTS_MD_PATH)
    return { content: file.content ?? '', head_commit: file.headCommit } satisfies api.AgentsMd
  })

  app.put('/projects/:id/agents-md', async (request) => {
    const { id } = parseInput(projectParams, request.params)
    const body = parseInput(api.updateAgentsMdSchema, request.body)
    const s = scope(deps.repos, request)
    const head = await s.knowledge.write(id, {
      scope: AGENTS_MD_PATH,
      baseCommit: body.base_commit,
      files: { [AGENTS_MD_PATH]: body.content },
      author: await gitAuthor(deps.repos, s.auth),
      message: 'knowledge: AGENTS.md',
    })
    return { head_commit: head }
  })

  app.get('/projects/:id/skills', async (request) => {
    const { id } = parseInput(projectParams, request.params)
    const { knowledge } = scope(deps.repos, request)
    const paths = await knowledge.list(id, SKILLS_DIR)
    const names = [
      ...new Set(
        paths.flatMap((path) => {
          const name = /^skills\/([^/]+)\/SKILL\.md$/.exec(path)?.[1]
          return name && api.skillNameSchema.safeParse(name).success ? [name] : []
        }),
      ),
    ].sort()
    return Promise.all(
      names.map(async (name) => {
        const source = (await knowledge.read(id, `${skillDir(name)}/SKILL.md`)).content ?? ''
        return {
          name,
          description: skillHeader(source)?.description ?? '',
          has_rules: paths.includes(`${skillDir(name)}/rules.yaml`),
        } satisfies api.SkillSummary
      }),
    )
  })

  app.get('/projects/:id/skills/:name', async (request) => {
    const { id, name } = parseInput(api.skillParamsSchema, request.params)
    const { knowledge } = scope(deps.repos, request)
    const skill = await knowledge.read(id, `${skillDir(name)}/SKILL.md`)
    if (skill.content === null) throw notFound('skill')
    const rules = await knowledge.read(id, `${skillDir(name)}/rules.yaml`)
    return {
      name,
      skill_md: skill.content,
      rules_yaml: rules.content,
      head_commit: await knowledge.head(id, skillDir(name)),
    } satisfies api.SkillDetail
  })

  app.put('/projects/:id/skills/:name', async (request) => {
    const { id, name } = parseInput(api.skillParamsSchema, request.params)
    const body = parseInput(api.updateSkillSchema, request.body)
    const skill = validateSkillSource(body.skill_md, name, `${skillDir(name)}/SKILL.md`)
    if (!skill.valid) throw invalid('SKILL.md', skill.errors)
    if (body.rules_yaml !== undefined) {
      const rules = validateSkillRulesSource(body.rules_yaml, `${skillDir(name)}/rules.yaml`)
      if (!rules.valid) throw invalid('rules.yaml', rules.errors)
    }
    const s = scope(deps.repos, request)
    const head = await s.knowledge.write(id, {
      scope: skillDir(name),
      baseCommit: body.base_commit,
      files: {
        [`${skillDir(name)}/SKILL.md`]: body.skill_md,
        ...(body.rules_yaml !== undefined
          ? { [`${skillDir(name)}/rules.yaml`]: body.rules_yaml }
          : {}),
      },
      // No rules.yaml sent: the skill has none any more.
      ...(body.rules_yaml === undefined ? { removePaths: [`${skillDir(name)}/rules.yaml`] } : {}),
      author: await gitAuthor(deps.repos, s.auth),
      message: `knowledge: skill ${name}`,
    })
    return { head_commit: head }
  })

  app.delete('/projects/:id/skills/:name', async (request, reply) => {
    const { id, name } = parseInput(api.skillParamsSchema, request.params)
    const { base_commit } = parseInput(api.deleteSkillQuerySchema, request.query)
    const s = scope(deps.repos, request)
    await s.knowledge.remove(id, {
      scope: skillDir(name),
      baseCommit: base_commit,
      author: await gitAuthor(deps.repos, s.auth),
      message: `knowledge: remove skill ${name}`,
    })
    return reply.status(204).send()
  })

  app.get('/projects/:id/mcp', async (request) => {
    const { id } = parseInput(projectParams, request.params)
    const file = await scope(deps.repos, request).knowledge.read(id, MCP_PATH)
    return { yaml: file.content ?? '', head_commit: file.headCommit } satisfies api.McpFile
  })

  app.put('/projects/:id/mcp', { config: { roles: ADMIN_ROLES } }, async (request) => {
    const { id } = parseInput(projectParams, request.params)
    const body = parseInput(api.updateMcpSchema, request.body)
    const checked = validateMcpSource(body.yaml, MCP_PATH, { stdioAllowlist: deps.stdioAllowlist })
    if (!checked.valid) throw invalid(MCP_PATH, checked.errors)
    const s = scope(deps.repos, request)
    const head = await s.knowledge.write(id, {
      scope: MCP_PATH,
      baseCommit: body.base_commit,
      files: { [MCP_PATH]: body.yaml },
      author: await gitAuthor(deps.repos, s.auth),
      message: 'knowledge: mcp.yaml',
    })
    await s.audit({ actor: `user:${s.auth.userId}`, action: 'mcp.update', target: id })
    // Plain text that looks like a token is saved but flagged (`inline_credential`).
    return { head_commit: head, warnings: checked.warnings.map(toDetail) }
  })
}
