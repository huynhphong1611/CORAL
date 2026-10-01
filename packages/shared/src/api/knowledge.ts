import { z } from 'zod'
import { MAX_AGENTS_MD_BYTES, MAX_SKILL_DESCRIPTION, SKILL_NAME_PATTERN } from '../knowledge/skill'
import { commitSha } from './common'

/** Largest `SKILL.md`, `rules.yaml` or `mcp.yaml` accepted by the editor routes. */
export const MAX_KNOWLEDGE_FILE_BYTES = 64 * 1024

export const skillNameSchema = z
  .string()
  .regex(SKILL_NAME_PATTERN, 'skill name must match [a-z0-9][a-z0-9-]{0,63}')

/** `GET /projects/:id/agents-md`: empty content when the file does not exist yet. */
export const agentsMdSchema = z.object({ content: z.string(), head_commit: commitSha })
export type AgentsMd = z.infer<typeof agentsMdSchema>

export const updateAgentsMdSchema = z.object({
  content: z.string().max(MAX_AGENTS_MD_BYTES),
  base_commit: commitSha,
})

/** Every knowledge write answers with the commit it made. */
export const knowledgeSavedSchema = z.object({ head_commit: commitSha })

export const skillSummarySchema = z.object({
  name: skillNameSchema,
  description: z.string().max(MAX_SKILL_DESCRIPTION),
  has_rules: z.boolean(),
})
export type SkillSummary = z.infer<typeof skillSummarySchema>

export const skillDetailSchema = z.object({
  name: skillNameSchema,
  skill_md: z.string(),
  rules_yaml: z.string().nullable(),
  head_commit: commitSha,
})
export type SkillDetail = z.infer<typeof skillDetailSchema>

export const skillParamsSchema = z.object({ id: z.uuid(), name: skillNameSchema })

/** No `rules_yaml` removes the skill's `rules.yaml`. */
export const updateSkillSchema = z.object({
  skill_md: z.string().min(1).max(MAX_KNOWLEDGE_FILE_BYTES),
  rules_yaml: z.string().max(MAX_KNOWLEDGE_FILE_BYTES).optional(),
  base_commit: commitSha,
})
export type UpdateSkill = z.infer<typeof updateSkillSchema>

export const deleteSkillQuerySchema = z.object({ base_commit: commitSha })

/** `GET /projects/:id/mcp`: empty YAML when the project has no `mcp.yaml`. */
export const mcpFileSchema = z.object({ yaml: z.string(), head_commit: commitSha })
export type McpFile = z.infer<typeof mcpFileSchema>

export const updateMcpSchema = z.object({
  yaml: z.string().max(MAX_KNOWLEDGE_FILE_BYTES),
  base_commit: commitSha,
})
