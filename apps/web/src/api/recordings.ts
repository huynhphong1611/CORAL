import { api, type ExpectCondition, type protocol } from '@coral/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
import { en } from '../i18n/en'
import { ApiError } from './client'
import { useCoral } from './queries'

export const recordingKeys = {
  list: (projectId: string) => ['recordings', { projectId }] as const,
  one: (id: string) => ['recordings', id] as const,
}

/** A recorded step waits for the screen to settle twice and uploads a snapshot (server: 45 s). */
const RECORD_REPLY_MS = 60_000

export type RecordingStepView = NonNullable<api.Recording['steps']>[number]
type StepInput = Omit<RecordingStepView, 'urls'>
type Inspected = protocol.UiPayload<'live.inspected'>

/** Unfinished recordings of a project (the project's Recordings tab). */
export function useRecordings(projectId: string) {
  const { client } = useCoral()
  return useQuery({
    queryKey: recordingKeys.list(projectId),
    queryFn: () => client.get(`/recordings?project_id=${projectId}`, api.recordingSchema.array()),
  })
}

/** What happened to the last command, for the notice line of the Recorder. */
export type RecorderNotice =
  | { kind: 'popup'; rule: string }
  | { kind: 'secret'; name: string }
  | { kind: 'error'; message: string }
  | { kind: 'ended'; reason: protocol.UiPayload<'live.ended'>['reason'] }

const withoutUrls = (steps: readonly RecordingStepView[]): StepInput[] =>
  steps.map(({ urls: _urls, ...step }) => step)

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'device_busy') return en.control.busy
    if (error.code === 'device_offline') return en.control.offline
    return error.message
  }
  return en.common.error
}

/**
 * The Recorder's state (US4, contracts/ui-ws.md + rest-api-phase2.md): the recording as the
 * server keeps it (a reload restores every step, FR-016), recorded commands and Assert-mode
 * inspection over `/ws/ui`, edits (delete, reorder, accept a suggestion) through PATCH.
 */
export function useRecorder(recordingId: string) {
  const { client, socket } = useCoral()
  const queryClient = useQueryClient()
  const key = recordingKeys.one(recordingId)
  const [notice, setNotice] = useState<RecorderNotice | undefined>()
  const [busy, setBusy] = useState(false)

  const recording = useQuery({
    queryKey: key,
    queryFn: () => client.get(`/recordings/${recordingId}`, api.recordingSchema),
  })
  const refetch = useCallback(
    () => queryClient.invalidateQueries({ queryKey: recordingKeys.one(recordingId) }),
    [queryClient, recordingId],
  )

  // Steps arrive over the socket; the recording is read again for their presigned image URLs.
  useEffect(
    () =>
      socket.on('recording.step', (message) => {
        if (message.payload.recording_id !== recordingId) return
        const { popup_rule, secret_hint } = message.payload
        if (popup_rule) setNotice({ kind: 'popup', rule: popup_rule })
        else if (secret_hint) setNotice({ kind: 'secret', name: secret_hint.name })
        else setNotice(undefined)
        void refetch()
      }),
    [socket, recordingId, refetch],
  )
  useEffect(
    () =>
      socket.on('live.ended', (message) => {
        if (message.payload.recording_id !== recordingId) return
        setNotice({ kind: 'ended', reason: message.payload.reason })
        void refetch()
      }),
    [socket, recordingId, refetch],
  )

  /** Sends a command; `record` makes it a step (Home and Restart app never are). */
  const send = useCallback(
    async (command: protocol.DeviceCommand, record = true) => {
      setBusy(true)
      try {
        const reply = await socket.request(
          'live.command',
          { recording_id: recordingId, command, ...(record ? { record: true } : {}) },
          RECORD_REPLY_MS,
        )
        if (reply.type === 'live.result' && reply.payload.ok) return
        const error =
          reply.type === 'live.result'
            ? reply.payload.error
            : reply.type === 'error'
              ? reply.payload
              : undefined
        setNotice({
          kind: 'error',
          message:
            error?.code === 'secret_required'
              ? en.recorder.secretRequired
              : (error?.message ?? en.common.error),
        })
        if (error?.code === 'session_ended') void refetch()
      } finally {
        setBusy(false)
      }
    },
    [socket, recordingId, refetch],
  )

  /** Assert mode: what is at a point of the screen, without touching it. */
  const inspect = useCallback(
    async (x: number, y: number): Promise<Inspected | undefined> => {
      const reply = await socket.request(
        'live.inspect',
        { recording_id: recordingId, x, y },
        RECORD_REPLY_MS,
      )
      if (reply.type === 'live.inspected') return reply.payload
      setNotice({
        kind: 'error',
        message: reply.type === 'error' ? reply.payload.message : en.common.error,
      })
      return undefined
    },
    [socket, recordingId],
  )

  const patch = useMutation({
    mutationFn: (body: api.PatchRecording) =>
      client.patch(`/recordings/${recordingId}`, body, api.recordingSchema),
    onSuccess: (updated) => queryClient.setQueryData(key, updated),
    onError: (error) => setNotice({ kind: 'error', message: describe(error) }),
  })

  const steps = recording.data?.steps ?? []
  const editSteps = (next: StepInput[]) => patch.mutate({ steps: next })

  /** Adds an expectation to a step (a suggestion accepted, or an Assert-mode pick). */
  const addExpect = (n: number, condition: ExpectCondition) =>
    editSteps(
      withoutUrls(steps).map((s) =>
        s.n !== n
          ? s
          : {
              ...s,
              step: { ...s.step, expect: [...(s.step.expect ?? []), condition] },
              suggestions: s.suggestions.filter(
                (c) => JSON.stringify(c) !== JSON.stringify(condition),
              ),
              warnings: s.warnings.filter((w) => w !== 'no_expect_after_tap'),
            },
      ),
    )
  const removeStep = (n: number) => editSteps(withoutUrls(steps).filter((s) => s.n !== n))
  const moveStep = (n: number, to: number) => {
    const list = withoutUrls(steps)
    const from = list.findIndex((s) => s.n === n)
    const [moved] = list.splice(from, 1)
    if (!moved || to < 0 || to > list.length) return
    list.splice(to, 0, moved)
    editSteps(list)
  }

  const lifecycle = (action: 'stop' | 'resume') =>
    client
      .post(`/recordings/${recordingId}/${action}`, {}, api.recordingSchema)
      .then((updated) => {
        queryClient.setQueryData(key, (old: api.Recording | undefined) =>
          old ? { ...old, status: updated.status } : updated,
        )
        setNotice(undefined)
      })
      .catch((error: unknown) => setNotice({ kind: 'error', message: describe(error) }))

  return {
    recording,
    steps,
    notice,
    busy,
    send,
    inspect,
    patch,
    addExpect,
    removeStep,
    moveStep,
    stop: () => lifecycle('stop'),
    resume: () => lifecycle('resume'),
    setNotice,
  }
}
