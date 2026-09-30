import { api } from '@coral/shared'
import { useMutation } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useApps, useBuilds, useCoral, useDevices, useProjects } from '../../api/queries'
import { PageHeader } from '../../components/Layout'
import { buttonClass, Card, errorMessage, formatTime, inputClass } from '../../components/ui'
import { en } from '../../i18n/en'

/**
 * `/projects/$projectId/record?app&build&device` (contracts/web-ui.md): pick an app build and an
 * idle device, then `POST /recordings` — the server prepares a fresh app — and open the Recorder.
 */
export function StartRecordingPage() {
  const { projectId } = useParams({ from: '/_app/projects/$projectId/record' })
  const search = useSearch({ from: '/_app/projects/$projectId/record' })
  const { client } = useCoral()
  const navigate = useNavigate()
  const project = useProjects().data?.find((p) => p.id === projectId)
  const apps = useApps(projectId)
  const devices = useDevices()
  const [appId, setAppId] = useState(search.app)
  const [buildId, setBuildId] = useState(search.build)
  const [deviceId, setDeviceId] = useState(search.device)
  const builds = useBuilds(appId)
  const idle = useMemo(
    () => (devices.data ?? []).filter((d) => d.activity.kind === 'idle'),
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
    if (deviceId === undefined && idle[0]) setDeviceId(idle[0].id)
  }, [idle, deviceId])

  const start = useMutation({
    mutationFn: () =>
      client.post(
        '/recordings',
        { project_id: projectId, app_id: appId, build_id: buildId, device_id: deviceId },
        api.recordingSchema,
      ),
    onSuccess: (recording) =>
      navigate({ to: '/recordings/$recordingId', params: { recordingId: recording.id } }),
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    start.mutate()
  }

  const noBuilds = apps.data?.length === 0 || builds.data?.length === 0
  return (
    <section>
      <nav aria-label="Breadcrumb" className="mb-2 text-sm text-slate-500">
        <Link
          to="/projects/$projectId"
          params={{ projectId }}
          search={{ tab: 'recordings' }}
          className="hover:text-slate-800"
        >
          {project?.name ?? en.recorder.back}
        </Link>
      </nav>
      <PageHeader title={en.recordStart.title} />
      <Card className="max-w-lg p-5">
        <form onSubmit={submit} className="space-y-4 text-sm">
          <p className="text-slate-600">{en.recordStart.subtitle}</p>
          <label className="block space-y-1">
            <span className="font-medium">{en.recordStart.app}</span>
            <select
              className={`${inputClass} w-full`}
              value={appId ?? ''}
              onChange={(e) => {
                setAppId(e.target.value)
                setBuildId(undefined)
              }}
            >
              {(apps.data ?? []).map((app) => (
                <option key={app.id} value={app.id}>
                  {app.name} ({app.package_or_bundle_id})
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="font-medium">{en.recordStart.build}</span>
            <select
              className={`${inputClass} w-full`}
              value={buildId ?? ''}
              onChange={(e) => setBuildId(e.target.value)}
            >
              {(builds.data ?? []).map((build) => (
                <option key={build.id} value={build.id}>
                  {build.version} · {formatTime(build.created_at)}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="font-medium">{en.recordStart.device}</span>
            <select
              className={`${inputClass} w-full`}
              value={deviceId ?? ''}
              onChange={(e) => setDeviceId(e.target.value)}
            >
              {idle.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.model} · {device.udid}
                </option>
              ))}
            </select>
          </label>
          {noBuilds && <p className="text-amber-800">{en.recordStart.noBuilds}</p>}
          {devices.data && idle.length === 0 && (
            <p className="text-amber-800">{en.recordStart.noDevices}</p>
          )}
          {start.isError && (
            <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-red-800">
              {errorMessage(start.error)}
            </p>
          )}
          <button
            type="submit"
            className={buttonClass.primary}
            disabled={!appId || !buildId || !deviceId || start.isPending}
          >
            {start.isPending ? en.recordStart.starting : en.recordStart.submit}
          </button>
        </form>
      </Card>
    </section>
  )
}
