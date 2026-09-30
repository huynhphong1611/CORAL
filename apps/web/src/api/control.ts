import { api, type protocol } from '@coral/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
import { en } from '../i18n/en'
import { ApiError } from './client'
import { useCoral } from './queries'

export const controlKey = (deviceId: string) => ['devices', deviceId, 'control'] as const

/** Why a request or command failed, in the server's words when it gave some. */
function describe(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'device_busy') return en.control.busy
    if (error.code === 'device_offline') return en.control.offline
    return error.message
  }
  return en.common.error
}

/**
 * Taking a device from the browser (US3, contracts/rest-api-phase2.md + ui-ws.md): the current
 * control session (kept across reloads by `GET …/control`), take / release, commands over
 * `/ws/ui`, when it will be released for inactivity, and what went wrong.
 */
export function useControl(deviceId: string, myUserId: string | undefined) {
  const { client, socket } = useCoral()
  const queryClient = useQueryClient()
  const key = controlKey(deviceId)
  const [notice, setNotice] = useState<string | undefined>()
  const [lastCommandAt, setLastCommandAt] = useState<number | undefined>()

  const session = useQuery({
    queryKey: key,
    queryFn: async () => {
      try {
        return await client.get(`/devices/${deviceId}/control`, api.controlSessionSchema)
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null
        throw error
      }
    },
  })
  const current = session.data ?? undefined
  const mine = current !== undefined && current.user.id === myUserId ? current : undefined

  useEffect(
    () =>
      socket.on('live.ended', (message) => {
        if (message.payload.live_session_id !== mine?.live_session_id) return
        queryClient.setQueryData(controlKey(deviceId), null)
        setNotice(en.control.ended[message.payload.reason])
      }),
    [socket, queryClient, deviceId, mine?.live_session_id],
  )

  const take = useMutation({
    mutationFn: () => client.post(`/devices/${deviceId}/control`, {}, api.controlSessionSchema),
    onMutate: () => setNotice(undefined),
    onSuccess: (taken) => {
      queryClient.setQueryData(key, taken)
      setLastCommandAt(Date.now())
    },
    onError: (error) => setNotice(describe(error)),
  })

  const release = useMutation({
    mutationFn: () => client.delete(`/devices/${deviceId}/control`),
    onSuccess: () => queryClient.setQueryData(key, null),
    onError: (error) => setNotice(describe(error)),
  })

  const send = useCallback(
    async (command: protocol.DeviceCommand) => {
      if (!mine) return
      const reply = await socket.request('live.command', {
        live_session_id: mine.live_session_id,
        command,
      })
      if (reply.type === 'live.result' && reply.payload.ok) {
        setLastCommandAt(Date.now())
        setNotice(undefined)
        return
      }
      const error =
        reply.type === 'live.result'
          ? reply.payload.error
          : reply.type === 'error'
            ? reply.payload
            : undefined
      if (error?.code === 'session_ended' || error?.code === 'not_holder') {
        queryClient.setQueryData(controlKey(deviceId), null)
      }
      setNotice(error?.message ?? en.common.error)
    },
    [socket, queryClient, deviceId, mine],
  )

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: controlKey(deviceId) }),
    [queryClient, deviceId],
  )

  // Each command pushes the automatic release back by the idle time (research R7).
  const releaseAt = mine
    ? lastCommandAt !== undefined
      ? lastCommandAt + mine.idle_timeout_ms
      : Date.parse(mine.expires_at)
    : undefined

  return {
    /** Anyone's open session on the device (undefined while loading or when none). */
    current,
    /** The caller's own session. */
    mine,
    take,
    release,
    send,
    releaseAt,
    notice,
    refresh,
  }
}
