import { api } from '@coral/shared'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useCoral } from './queries'

export const testCaseKeys = {
  one: (id: string) => ['testcases', id] as const,
  history: (id: string) => ['testcases', id, 'history'] as const,
  snapshots: (id: string, commit: string) => ['testcases', id, 'snapshots', commit] as const,
  lastRunSteps: (id: string) => ['testcases', id, 'last-run-steps'] as const,
}

/** The test case with its YAML at the head commit. */
export function useTestCase(id: string) {
  const { client } = useCoral()
  return useQuery({
    queryKey: testCaseKeys.one(id),
    queryFn: () => client.get(`/testcases/${id}`, api.testCaseDetailSchema),
    // The editor keeps its own copy while someone types; no refetch behind its back.
    refetchOnWindowFocus: false,
  })
}

/** Commits that changed the test case, newest first (FR-020). */
export function useHistory(id: string, enabled = true) {
  const { client } = useCoral()
  return useQuery({
    queryKey: testCaseKeys.history(id),
    queryFn: () => client.get(`/testcases/${id}/history`, api.historyEntrySchema.array()),
    enabled,
  })
}

/** The Recorder's snapshot of each step at `commit` (FR-019). */
export function useSnapshots(id: string, commit: string) {
  const { client } = useCoral()
  return useQuery({
    queryKey: testCaseKeys.snapshots(id, commit),
    queryFn: () => client.get(`/testcases/${id}/snapshots`, api.testCaseSnapshotsSchema),
  })
}

/** Step screenshots of the latest run: the picture when a step has no snapshot (FR-019). */
export function useLastRunSteps(id: string) {
  const { client } = useCoral()
  return useQuery({
    queryKey: testCaseKeys.lastRunSteps(id),
    queryFn: () => client.get(`/testcases/${id}/last-run-steps`, api.lastRunStepsSchema),
  })
}

/**
 * An object URL for an API file (it needs the access token, so no plain `<img src>`): undefined
 * while loading, null when it failed. Revoked when the component goes away or the path changes.
 */
export function useApiFile(path: string | undefined): string | null | undefined {
  const { client } = useCoral()
  const [url, setUrl] = useState<string | null | undefined>()
  useEffect(() => {
    setUrl(undefined)
    if (!path) return undefined
    let objectUrl: string | undefined
    let live = true
    client
      .blob(path)
      .then((blob) => {
        if (!live) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch(() => live && setUrl(null))
    return () => {
      live = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [client, path])
  return url
}
