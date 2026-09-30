import { api, type protocol } from '@coral/shared'
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { useEffect, useSyncExternalStore } from 'react'
import { z } from 'zod'

/** Client, socket and session of the signed-in app. */
export function useCoral() {
  return useRouteContext({ from: '/_app' })
}

/** The caller's role; viewers see no write buttons (FR-002a — the server refuses them too). */
export function useRole() {
  const { session } = useCoral()
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const role = snapshot.session?.tenant.role
  return { role, canWrite: role !== undefined && role !== 'viewer' }
}

export const keys = {
  projects: ['projects'] as const,
  testCases: (projectId: string) => ['projects', projectId, 'testcases'] as const,
  apps: (projectId: string) => ['projects', projectId, 'apps'] as const,
  builds: (appId: string) => ['apps', appId, 'builds'] as const,
  devices: ['devices'] as const,
  agents: ['agents'] as const,
  runs: (filters: RunFilters) => ['runs', 'list', filters] as const,
  runLists: ['runs', 'list'] as const,
  run: (runId: string) => ['runs', runId] as const,
  steps: (runId: string, itemId: string) => ['runs', runId, 'items', itemId, 'steps'] as const,
}

export function useProjects() {
  const { client } = useCoral()
  return useQuery({
    queryKey: keys.projects,
    queryFn: () => client.get('/projects', api.projectSchema.array()),
  })
}

export function useTestCases(projectId: string) {
  const { client } = useCoral()
  return useQuery({
    queryKey: keys.testCases(projectId),
    queryFn: () =>
      client.get(`/projects/${projectId}/testcases`, api.testCaseSummarySchema.array()),
  })
}

export function useApps(projectId: string) {
  const { client } = useCoral()
  return useQuery({
    queryKey: keys.apps(projectId),
    queryFn: () => client.get(`/projects/${projectId}/apps`, api.appSchema.array()),
  })
}

export function useBuilds(appId: string | undefined) {
  const { client } = useCoral()
  return useQuery({
    queryKey: keys.builds(appId ?? ''),
    queryFn: () => client.get(`/apps/${appId}/builds`, api.buildSchema.array()),
    enabled: appId !== undefined,
  })
}

/** The tenant's agents (US7): name, status, what they run on. */
export function useAgents() {
  const { client } = useCoral()
  return useQuery({
    queryKey: keys.agents,
    queryFn: () => client.get('/agents', api.agentSchema.array()),
  })
}

/** Devices with their activity, kept current by `devices.updated` (no polling). */
export function useDevices() {
  const { client, socket } = useCoral()
  const queryClient = useQueryClient()
  useEffect(
    () =>
      socket.on('devices.updated', (message) =>
        queryClient.setQueryData(keys.devices, message.payload.devices),
      ),
    [socket, queryClient],
  )
  return useQuery({
    queryKey: keys.devices,
    queryFn: () => client.get('/devices', api.deviceViewSchema.array()),
  })
}

export interface RunFilters {
  project_id?: string | undefined
  status?: api.Run['status'] | undefined
  device_id?: string | undefined
  test_case_id?: string | undefined
}

const runPageSchema = z.object({
  items: api.runSchema.array(),
  next_cursor: z.string().nullable(),
})
type RunPage = z.infer<typeof runPageSchema>

/** Runs, newest first, a page at a time. */
export function useRuns(filters: RunFilters, limit = 20) {
  const { client } = useCoral()
  return useInfiniteQuery({
    queryKey: keys.runs(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ limit: String(limit) })
      for (const [name, value] of Object.entries(filters)) {
        if (typeof value === 'string' && value) query.set(name, value)
      }
      if (pageParam) query.set('cursor', pageParam)
      return client.get(`/runs?${query.toString()}`, runPageSchema)
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  })
}

export function useRun(runId: string) {
  const { client } = useCoral()
  return useQuery({
    queryKey: keys.run(runId),
    queryFn: () => client.get(`/runs/${runId}`, api.runSchema),
  })
}

export function useSteps(runId: string, itemId: string) {
  const { client } = useCoral()
  return useQuery({
    queryKey: keys.steps(runId, itemId),
    queryFn: () => client.get(`/runs/${runId}/items/${itemId}/steps`, api.runStepSchema.array()),
  })
}

type RunUpdated = protocol.UiPayload<'run.updated'>

/** A run with a `run.updated` applied (statuses, failure codes, times). */
export function applyRunUpdate(run: api.Run, update: RunUpdated): api.Run {
  if (run.id !== update.run_id) return run
  return {
    ...run,
    status: update.status,
    failure_code: update.failure_code ?? null,
    started_at: update.started_at ?? run.started_at,
    finished_at: update.finished_at ?? run.finished_at,
    items: run.items.map((item) => {
      const next = update.items.find((i) => i.id === item.id)
      return next
        ? {
            ...item,
            status: next.status,
            failure_code: next.failure_code ?? null,
            failed_step_id: next.failed_step_id ?? null,
          }
        : item
    }),
  }
}

const ACTIVE: ReadonlySet<api.Run['status']> = new Set(['queued', 'running'])
export const isActive = (run: Pick<api.Run, 'status'>) => ACTIVE.has(run.status)

function applyEverywhere(queryClient: QueryClient, update: RunUpdated) {
  queryClient.setQueryData<api.Run>(keys.run(update.run_id), (run) =>
    run ? applyRunUpdate(run, update) : run,
  )
  queryClient.setQueriesData<InfiniteData<RunPage>>({ queryKey: keys.runLists }, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((run) => applyRunUpdate(run, update)),
          })),
        }
      : data,
  )
}

/**
 * Watches runs over `/ws/ui` while mounted (again after every reconnection): `run.updated` goes
 * into the cached run and run lists, `run.step` refetches that item's steps (presigned images).
 */
export function useWatchRuns(runIds: readonly string[]) {
  const { socket } = useCoral()
  const queryClient = useQueryClient()
  const joined = [...runIds].sort().join(',')
  useEffect(() => {
    const ids = joined ? joined.split(',') : []
    if (ids.length === 0) return undefined
    const watched = new Set(ids)
    const offUpdated = socket.on('run.updated', (message) => {
      if (watched.has(message.payload.run_id)) applyEverywhere(queryClient, message.payload)
    })
    const offStep = socket.on('run.step', (message) => {
      const { run_id: runId, run_item_id: itemId } = message.payload
      if (watched.has(runId))
        void queryClient.invalidateQueries({ queryKey: keys.steps(runId, itemId) })
    })
    const offReady = socket.onReady(() => {
      for (const id of ids) socket.send('run.watch', { run_id: id })
    })
    socket.connect()
    return () => {
      offUpdated()
      offStep()
      offReady()
      for (const id of ids) socket.send('run.unwatch', { run_id: id })
    }
  }, [socket, queryClient, joined])
}
