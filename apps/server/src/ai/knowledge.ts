import type { ProjectKnowledge } from '@coral/brain'
import {
  SKILL_NAME_PATTERN,
  mergeRules,
  validateMcpSource,
  validateSkillRulesSource,
  validateSkillSource,
  type McpConfig,
  type ProjectRules,
  type SkillRules,
} from '@coral/shared'
import type { ProjectRepoStore } from '../git/project-repo-store'

export const AGENTS_MD_PATH = 'AGENTS.md'
export const SKILLS_DIR = 'skills'
export const MCP_PATH = 'mcp.yaml'
/** `AGENTS.md` beyond this is not sent to the AI (research R6). */
export const AGENTS_MD_AI_CHARS = 16 * 1024
/** Skills listed to the AI (research R6). */
export const MAX_SKILLS = 50

const SECRET_REF = /^\$\{secret:([A-Za-z_][A-Za-z0-9_]*)\}$/

/** What the AI roles of one project know, read from that project's repo only (FR-012). */
export interface LoadedKnowledge {
  knowledge: ProjectKnowledge
  /** Contents of the listed skills (the `read_skill` tool), name → SKILL.md body. */
  skillBodies: Map<string, string>
  /** never_tap, forbidden elements, test data and allow_submit of every skill, merged (D42). */
  rules: ProjectRules
  /** `mcp.yaml` when valid; a broken one gives the AI no tools. */
  mcp: McpConfig | null
  /** Files that could not be read, for the activity log. */
  problems: string[]
}

/** Named test data for the prompt: `${secret:NAME}` values show only their name (FR-013). */
export function promptTestData(rules: ProjectRules): ProjectKnowledge['testData'] {
  return Object.entries(rules.testData).map(([name, value]) => {
    const secret = SECRET_REF.exec(value)?.[1]
    return secret !== undefined ? { name, secret } : { name, value }
  })
}

/**
 * Reads `AGENTS.md`, `skills/*` and `mcp.yaml` of the project at `commit` (default: head).
 * Invalid files are skipped and reported in `problems`; they never stop an exploration.
 */
export async function loadKnowledge(
  store: ProjectRepoStore,
  tenantId: string,
  projectId: string,
  options: { stdioAllowlist: readonly string[]; commit?: string },
): Promise<LoadedKnowledge> {
  const commit = options.commit ?? 'HEAD'
  const read = (path: string) => store.readFile(tenantId, projectId, path, commit)
  const problems: string[] = []

  const agentsMd = ((await read(AGENTS_MD_PATH)) ?? '').slice(0, AGENTS_MD_AI_CHARS)

  const paths = await store.listFiles(tenantId, projectId, SKILLS_DIR, commit)
  const names = [
    ...new Set(
      paths
        .map((path) => /^skills\/([^/]+)\/SKILL\.md$/.exec(path)?.[1])
        .filter((name): name is string => name !== undefined && SKILL_NAME_PATTERN.test(name)),
    ),
  ].sort()
  const skills: ProjectKnowledge['skills'] = []
  const skillBodies = new Map<string, string>()
  const allRules: SkillRules[] = []
  for (const name of names.slice(0, MAX_SKILLS)) {
    const source = (await read(`${SKILLS_DIR}/${name}/SKILL.md`)) ?? ''
    const skill = validateSkillSource(source, name, `${SKILLS_DIR}/${name}/SKILL.md`)
    if (!skill.valid || !skill.value) {
      problems.push(`${SKILLS_DIR}/${name}/SKILL.md: ${skill.errors[0]?.message ?? 'invalid'}`)
      continue
    }
    skills.push({ name, description: skill.value.description })
    skillBodies.set(name, skill.value.body)
    const rulesSource = await read(`${SKILLS_DIR}/${name}/rules.yaml`)
    if (rulesSource === null) continue
    const rules = validateSkillRulesSource(rulesSource, `${SKILLS_DIR}/${name}/rules.yaml`)
    if (rules.valid && rules.value) allRules.push(rules.value)
    else problems.push(`${SKILLS_DIR}/${name}/rules.yaml: ${rules.errors[0]?.message ?? 'invalid'}`)
  }
  if (names.length > MAX_SKILLS) problems.push(`only the first ${MAX_SKILLS} skills are used`)
  const rules = mergeRules(allRules)

  let mcp: McpConfig | null = null
  const mcpSource = await read(MCP_PATH)
  if (mcpSource !== null) {
    const result = validateMcpSource(mcpSource, MCP_PATH, {
      stdioAllowlist: options.stdioAllowlist,
    })
    if (result.valid && result.value) mcp = result.value
    else problems.push(`${MCP_PATH}: ${result.errors[0]?.message ?? 'invalid'}`)
  }

  return {
    knowledge: { agentsMd, skills, testData: promptTestData(rules) },
    skillBodies,
    rules,
    mcp,
    problems,
  }
}
