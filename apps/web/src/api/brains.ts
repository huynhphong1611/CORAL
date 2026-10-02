import { api } from '@coral/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCoral } from './queries'

export const brainKeys = {
  config: ['brains', 'config'] as const,
  usage: (group: api.UsageQuery['group']) => ['usage', 'ai', group] as const,
}

/** The tenant's brains config in force, where it comes from, and the providers of the server. */
export function useBrainsConfig() {
  const { client } = useCoral()
  return useQuery({
    queryKey: brainKeys.config,
    queryFn: () => client.get('/brains/config', api.brainsConfigViewSchema),
    // The editor keeps its own copy while someone types.
    refetchOnWindowFocus: false,
  })
}

/** PUT /brains/config with the YAML as written (comments kept); owner/admin. */
export function useSaveBrains() {
  const { client } = useCoral()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (yaml: string) =>
      client.putText('/brains/config', yaml, 'application/yaml', api.brainsConfigViewSchema),
    onSuccess: (view) => {
      queryClient.setQueryData(brainKeys.config, view)
      void queryClient.invalidateQueries({ queryKey: ['usage', 'ai'] })
    },
  })
}

/** What the AI cost, by UTC day, role or provider, and today against the daily limit (FR-010). */
export function useAiUsage(group: api.UsageQuery['group']) {
  const { client } = useCoral()
  return useQuery({
    queryKey: brainKeys.usage(group),
    queryFn: () => client.get(`/usage/ai?group=${group}`, api.usageSchema),
  })
}
