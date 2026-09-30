import { api } from '@coral/shared'
import { useMutation } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react'
import { useApps, useBuilds, useCoral, useDevices } from '../api/queries'
import { en } from '../i18n/en'
import { buttonClass, errorMessage, formatTime, inputClass } from './ui'
import { activityLabel } from './activity'

const createdRunSchema = api.runSchema.pick({ id: true })

/**
 * Run test cases (FR-004, T025): pick a build of one of the project's apps and a device, then
 * `POST /runs` and go to the run. Offline devices cannot be picked; a busy one queues the run.
 */
export function RunDialog({
  projectId,
  testCaseIds,
  onClose,
}: {
  projectId: string
  testCaseIds: readonly string[]
  onClose: () => void
}) {
  const { client } = useCoral()
  const navigate = useNavigate()
  const titleId = useId()
  const apps = useApps(projectId)
  const devices = useDevices()
  const [appId, setAppId] = useState<string | undefined>()
  const [buildId, setBuildId] = useState<string | undefined>()
  const [deviceId, setDeviceId] = useState<string | undefined>()
  const builds = useBuilds(appId)
  const online = useMemo(
    () => (devices.data ?? []).filter((d) => d.activity.kind !== 'offline'),
    [devices.data],
  )

  // Defaults: the first app, its newest build, the first idle device.
  useEffect(() => {
    if (appId === undefined && apps.data?.[0]) setAppId(apps.data[0].id)
  }, [apps.data, appId])
  useEffect(() => {
    if (builds.data && !builds.data.some((b) => b.id === buildId)) setBuildId(builds.data[0]?.id)
  }, [builds.data, buildId])
  useEffect(() => {
    if (deviceId === undefined && online.length > 0) {
      setDeviceId((online.find((d) => d.activity.kind === 'idle') ?? online[0])?.id)
    }
  }, [online, deviceId])

  const start = useMutation({
    mutationFn: () =>
      client.post(
        '/runs',
        {
          project_id: projectId,
          build_id: buildId,
          device_id: deviceId,
          test_case_ids: testCaseIds,
        },
        createdRunSchema,
      ),
    onSuccess: (run) => navigate({ to: '/runs/$runId', params: { runId: run.id } }),
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    start.mutate()
  }

  const noBuilds = apps.data?.length === 0 || builds.data?.length === 0
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/30 p-4">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={submit}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
        className="w-full max-w-md space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-lg"
      >
        <div>
          <h2 id={titleId} className="text-lg font-semibold tracking-tight">
            {en.runDialog.title}
          </h2>
          <p className="text-sm text-slate-500">{en.runDialog.subtitle(testCaseIds.length)}</p>
        </div>
        <label className="block space-y-1 text-sm">
          <span className="font-medium text-slate-700">{en.runDialog.app}</span>
          <select
            className={`${inputClass} w-full`}
            value={appId ?? ''}
            onChange={(e) => setAppId(e.target.value)}
          >
            {apps.data?.map((app) => (
              <option key={app.id} value={app.id}>
                {app.name} ({app.package_or_bundle_id})
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1 text-sm">
          <span className="font-medium text-slate-700">{en.runDialog.build}</span>
          <select
            className={`${inputClass} w-full`}
            value={buildId ?? ''}
            onChange={(e) => setBuildId(e.target.value)}
          >
            {builds.data?.map((build) => (
              <option key={build.id} value={build.id}>
                {build.version} · {formatTime(build.created_at)}
              </option>
            ))}
          </select>
        </label>
        {noBuilds && <p className="text-sm text-amber-700">{en.runDialog.noBuilds}</p>}
        <label className="block space-y-1 text-sm">
          <span className="font-medium text-slate-700">{en.runDialog.device}</span>
          <select
            className={`${inputClass} w-full`}
            value={deviceId ?? ''}
            onChange={(e) => setDeviceId(e.target.value)}
          >
            {online.map((device) => (
              <option key={device.id} value={device.id}>
                {device.model} · {device.udid} · {activityLabel(device.activity)}
              </option>
            ))}
          </select>
        </label>
        {devices.data && online.length === 0 && (
          <p className="text-sm text-amber-700">{en.runDialog.noDevices}</p>
        )}
        {start.isError && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorMessage(start.error)}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {en.common.cancel}
          </button>
          <button
            type="submit"
            className={buttonClass.primary}
            disabled={!buildId || !deviceId || start.isPending}
          >
            {start.isPending ? en.runDialog.submitting : en.runDialog.submit}
          </button>
        </div>
      </form>
    </div>
  )
}
