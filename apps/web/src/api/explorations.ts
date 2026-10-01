import { api, type protocol } from '@coral/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useCoral } from './queries'

export const explorationKeys = {
  list: (projectId: string) => ['explorations', { projectId }] as const,
  one: (id: string) => ['explorations', id] as const,
  steps: (id: string) => ['explorations', id, 'steps'] as const,
  brainCall: (id: string) => ['brain-calls', id] as const,
}

/** Statuses in which an exploration still changes (the page watches it). */
const ACTIVE: ReadonlySet<api.ExplorationStatus> = new Set(['queued', 'running', 'writing'])
export const isExploring = (e: Pick<api.Exploration, 'status'>) => ACTIVE.has(e.status)

/** Steps read per request (the server allows 200). */
const PAGE = 200

/** Explorations of a project, newest first (the project's Explorations tab). */
export function useExplorations(projectId: string) {
  const { client } = useCoral()
  return useQuery({
    queryKey: explorationKeys.list(projectId),
    queryFn: () =>
      client.get(`/explorations?project_id=${projectId}`, api.explorationSchema.array()),
  })
}

export function useExploration(id: string) {
  const { client } = useCoral()
  return useQuery({
    queryKey: explorationKeys.one(id),
    queryFn: () => client.get(`/explorations/${id}`, api.explorationDetailSchema),
  })
}

/** The whole trace, read a page at a time; `exploration.step` appends to it while it runs. */
export function useExplorationSteps(id: string) {
  const { client } = useCoral()
  return useQuery({
    queryKey: explorationKeys.steps(id),
    queryFn: async () => {
      const steps: api.ExplorationStepView[] = []
      for (;;) {
        const after = steps.at(-1)?.n ?? 0
        const page = await client.get(
          `/explorations/${id}/steps?after=${after}&limit=${PAGE}`,
          api.explorationStepSchema.array(),
        )
        steps.push(...page)
        if (page.length < PAGE) return steps
      }
    },
  })
}

/** What the AI saw and answered for a step (FR-006a); `content` is null after 30 days. */
export function useBrainCall(id: string | null | undefined) {
  const { client } = useCoral()
  return useQuery({
    queryKey: explorationKeys.brainCall(id ?? ''),
    queryFn: () => client.get(`/brain-calls/${id}`, api.brainCallSchema),
    enabled: Boolean(id),
    staleTime: Infinity,
  })
}

type Current = protocol.UiPayload<'exploration.updated'>['current']

/** A step added to the trace once (a refetch and the socket may both bring it). */
function withStep(steps: api.ExplorationStepView[] | undefined, step: api.ExplorationStepView) {
  if (!steps) return steps
  if (steps.some((s) => s.n === step.n)) return steps
  return [...steps, step].sort((a, b) => a.n - b.n)
}

/**
 * Follows an exploration over `/ws/ui` while it runs (contracts/ui-ws-phase3.md): status and
 * totals go into the cached exploration, steps into the trace, a newly named screen reloads the
 * exploration (its app map). Returns what the Explorer is doing now. A reload starts from REST.
 */
export function useWatchExploration(id: string, active: boolean): Current {
  const { socket } = useCoral()
  const queryClient = useQueryClient()
  const [current, setCurrent] = useState<Current>()
  useEffect(() => {
    if (!active) return undefined
    const offUpdated = socket.on('exploration.updated', ({ payload }) => {
      if (payload.exploration_id !== id) return
      setCurrent(payload.current)
      queryClient.setQueryData<api.ExplorationDetail>(explorationKeys.one(id), (old) =>
        old
          ? {
              ...old,
              status: payload.status,
              stop_reason: payload.stop_reason ?? old.stop_reason,
              stats: payload.stats,
            }
          : old,
      )
      if (!ACTIVE.has(payload.status)) {
        // Finished: the app map, test cases and end time come from the server once more.
        void queryClient.invalidateQueries({ queryKey: explorationKeys.one(id) })
      }
    })
    const offStep = socket.on('exploration.step', ({ payload }) => {
      if (payload.exploration_id !== id) return
      queryClient.setQueryData<api.ExplorationStepView[]>(explorationKeys.steps(id), (old) =>
        withStep(old, payload.step),
      )
    })
    const offScreen = socket.on('exploration.screen', ({ payload }) => {
      if (payload.exploration_id === id) {
        void queryClient.invalidateQueries({ queryKey: explorationKeys.one(id) })
      }
    })
    const offReady = socket.onReady(() => socket.send('exploration.watch', { exploration_id: id }))
    socket.connect()
    return () => {
      offUpdated()
      offStep()
      offScreen()
      offReady()
      socket.send('exploration.unwatch', { exploration_id: id })
    }
  }, [socket, queryClient, id, active])
  return active ? current : undefined
}

/** POST /explorations/:id/stop: answers once the exploration left `running`. */
export function useStopExploration(id: string) {
  const { client } = useCoral()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => client.post(`/explorations/${id}/stop`, {}, api.explorationSchema),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: explorationKeys.one(id) }),
  })
}
