import { api } from '@coral/shared'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { useCoral } from './queries'

export const knowledgeKeys = {
  all: (projectId: string) => ['projects', projectId, 'knowledge'] as const,
  agentsMd: (projectId: string) => ['projects', projectId, 'knowledge', 'agents-md'] as const,
  skills: (projectId: string) => ['projects', projectId, 'knowledge', 'skills'] as const,
  skill: (projectId: string, name: string) =>
    ['projects', projectId, 'knowledge', 'skills', name] as const,
  mcp: (projectId: string) => ['projects', projectId, 'knowledge', 'mcp'] as const,
}

/**
 * The base of a file that does not exist yet: the server takes any base for a file never
 * written, and refuses this one once someone created it in the meantime (409).
 */
export const NEW_FILE_BASE = '0'.repeat(40)

const noRefetch = { refetchOnWindowFocus: false } as const

export function useAgentsMd(projectId: string) {
  const { client } = useCoral()
  return useQuery({
    queryKey: knowledgeKeys.agentsMd(projectId),
    queryFn: () => client.get(`/projects/${projectId}/agents-md`, api.agentsMdSchema),
    ...noRefetch,
  })
}

export function useSkills(projectId: string) {
  const { client } = useCoral()
  return useQuery({
    queryKey: knowledgeKeys.skills(projectId),
    queryFn: () => client.get(`/projects/${projectId}/skills`, api.skillSummarySchema.array()),
  })
}

export function useSkill(projectId: string, name: string | undefined) {
  const { client } = useCoral()
  return useQuery({
    queryKey: knowledgeKeys.skill(projectId, name ?? ''),
    queryFn: () => client.get(`/projects/${projectId}/skills/${name}`, api.skillDetailSchema),
    enabled: name !== undefined,
    ...noRefetch,
  })
}

export function useMcp(projectId: string) {
  const { client } = useCoral()
  return useQuery({
    queryKey: knowledgeKeys.mcp(projectId),
    queryFn: () => client.get(`/projects/${projectId}/mcp`, api.mcpFileSchema),
    ...noRefetch,
  })
}

/** What a knowledge save answers: the new head, and warnings for mcp.yaml. */
export const savedKnowledgeSchema = api.knowledgeSavedSchema.extend({
  warnings: z.array(api.validationIssueSchema).optional(),
})
