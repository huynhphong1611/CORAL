import { api } from '@coral/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useCoral } from './queries'

export const importKeys = {
  list: (projectId: string) => ['imports', { projectId }] as const,
  one: (id: string) => ['imports', id] as const,
}

export const isImporting = (job: Pick<api.ImportJob, 'status'>) => job.status === 'running'

/** Import jobs of a project, newest first (the project's Imports tab). */
export function useImports(projectId: string) {
  const { client } = useCoral()
  return useQuery({
    queryKey: importKeys.list(projectId),
    queryFn: () => client.get(`/imports?project_id=${projectId}`, api.importJobSchema.array()),
  })
}

export function useImport(id: string) {
  const { client } = useCoral()
  return useQuery({
    queryKey: importKeys.one(id),
    queryFn: () => client.get(`/imports/${id}`, api.importJobDetailSchema),
  })
}

/**
 * Follows an import job over `/ws/ui` while it runs (contracts/ui-ws-phase3.md): status and
 * totals go into the cached job; a case that started or ended, or the job's end, reloads it (the
 * cases, their evidence and the report come from REST).
 */
export function useWatchImport(id: string, active: boolean): void {
  const { socket } = useCoral()
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!active) return undefined
    const offUpdated = socket.on('import.updated', ({ payload }) => {
      if (payload.import_job_id !== id) return
      queryClient.setQueryData<api.ImportJobDetail>(importKeys.one(id), (old) =>
        old ? { ...old, status: payload.status, stats: payload.stats } : old,
      )
      if (payload.item || payload.status !== 'running') {
        void queryClient.invalidateQueries({ queryKey: importKeys.one(id) })
      }
    })
    const offReady = socket.onReady(() => socket.send('import.watch', { import_job_id: id }))
    socket.connect()
    return () => {
      offUpdated()
      offReady()
      socket.send('import.unwatch', { import_job_id: id })
    }
  }, [socket, queryClient, id, active])
}
