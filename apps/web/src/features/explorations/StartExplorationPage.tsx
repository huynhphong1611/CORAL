import { api } from '@coral/shared'
import { useMutation } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { ApiError } from '../../api/client'
import { useApps, useBuilds, useCoral, useDevices, useProjects } from '../../api/queries'
import { PageHeader } from '../../components/Layout'
import { buttonClass, Card, errorMessage, formatTime, inputClass } from '../../components/ui'
import { en } from '../../i18n/en'

const t = en.exploreStart

/** A number field of the budget; empty means "the default". */
function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  placeholder,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  min: number
  max: number
  step?: number
  placeholder?: string
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-slate-600">{label}</span>
      <input
        type="number"
        className={`${inputClass} w-full`}
        value={value}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}

const asNumber = (value: string) => (value.trim() === '' ? undefined : Number(value))

/**
 * `/projects/$projectId/explore?app&build&device` (contracts/web-ui-phase3.md): an app build, an
 * idle device, an optional goal (a test case from a prompt, US5), the budget with its defaults and
 * how many test cases to write; then `POST /explorations` and the exploration's page.
 */
export function StartExplorationPage() {
  const { projectId } = useParams({ from: '/_app/projects/$projectId/explore' })
  const search = useSearch({ from: '/_app/projects/$projectId/explore' })
  const { client } = useCoral()
  const navigate = useNavigate()
  const project = useProjects().data?.find((p) => p.id === projectId)
  const apps = useApps(projectId)
  const devices = useDevices()
  const [appId, setAppId] = useState(search.app)
  const [buildId, setBuildId] = useState(search.build)
  const [deviceId, setDeviceId] = useState(search.device)
  const [goal, setGoal] = useState('')
  const [maxSteps, setMaxSteps] = useState(String(api.DEFAULT_EXPLORATION_BUDGET.max_steps))
  const [maxDepth, setMaxDepth] = useState(String(api.DEFAULT_EXPLORATION_BUDGET.max_depth))
  const [maxMinutes, setMaxMinutes] = useState(String(api.DEFAULT_EXPLORATION_BUDGET.max_minutes))
  const [maxCost, setMaxCost] = useState('')
  const [maxTests, setMaxTests] = useState<string | undefined>()
  const builds = useBuilds(appId)
  const idle = useMemo(
    () => (devices.data ?? []).filter((d) => d.activity.kind === 'idle'),
    [devices.data],
  )

  useEffect(() => {
    if (appId === undefined && apps.data?.[0]) setAppId(apps.data[0].id)
  }, [apps.data, appId])
  useEffect(() => {
    if (builds.data && !builds.data.some((b) => b.id === buildId)) setBuildId(builds.data[0]?.id)
  }, [builds.data, buildId])
  useEffect(() => {
    if (deviceId === undefined && idle[0]) setDeviceId(idle[0].id)
  }, [idle, deviceId])

  // One test case for a goal, five for a free exploration — unless the person chose.
  const testsDefault = goal.trim() ? api.DEFAULT_MAX_TESTS_WITH_GOAL : api.DEFAULT_MAX_TESTS
  const tests = maxTests ?? String(testsDefault)

  const start = useMutation({
    mutationFn: () => {
      const cost = asNumber(maxCost)
      return client.post(
        '/explorations',
        {
          project_id: projectId,
          app_id: appId,
          build_id: buildId,
          device_id: deviceId,
          ...(goal.trim() ? { goal: goal.trim() } : {}),
          budget: {
            max_steps: asNumber(maxSteps),
            max_depth: asNumber(maxDepth),
            max_minutes: asNumber(maxMinutes),
            ...(cost !== undefined ? { max_cost_usd: cost } : {}),
          },
          max_tests: asNumber(tests),
        },
        api.explorationSchema,
      )
    },
    onSuccess: (exploration) =>
      navigate({
        to: '/explorations/$explorationId',
        params: { explorationId: exploration.id },
        search: { tab: 'progress' },
      }),
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    start.mutate()
  }

  const notConfigured =
    start.error instanceof ApiError && start.error.code === 'brains_not_configured'
  const noBuilds = apps.data?.length === 0 || builds.data?.length === 0
  return (
    <section>
      <nav aria-label="Breadcrumb" className="mb-2 text-sm text-slate-500">
        <Link
          to="/projects/$projectId"
          params={{ projectId }}
          search={{ tab: 'explorations' }}
          className="hover:text-slate-800"
        >
          {project?.name ?? en.exploration.back}
        </Link>
      </nav>
      <PageHeader title={t.title} />
      <Card className="max-w-xl p-5">
        <form onSubmit={submit} className="space-y-4 text-sm">
          <p className="text-slate-600">{t.subtitle}</p>
          <label className="block space-y-1">
            <span className="font-medium">{t.app}</span>
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
            <span className="font-medium">{t.build}</span>
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
            <span className="font-medium">{t.device}</span>
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
          <div className="space-y-1">
            <label className="block space-y-1">
              <span className="font-medium">{t.goal}</span>
              <textarea
                className={`${inputClass} w-full`}
                rows={2}
                maxLength={api.MAX_GOAL_LENGTH}
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
              />
            </label>
            <p className="text-xs text-slate-500">{t.goalHint}</p>
          </div>
          <fieldset className="space-y-2">
            <legend className="font-medium">{t.budget}</legend>
            <div className="grid grid-cols-4 gap-3">
              <NumberField
                label={t.maxSteps}
                value={maxSteps}
                onChange={setMaxSteps}
                min={1}
                max={500}
              />
              <NumberField
                label={t.maxDepth}
                value={maxDepth}
                onChange={setMaxDepth}
                min={1}
                max={50}
              />
              <NumberField
                label={t.maxMinutes}
                value={maxMinutes}
                onChange={setMaxMinutes}
                min={1}
                max={240}
              />
              <NumberField
                label={t.maxCost}
                value={maxCost}
                onChange={setMaxCost}
                min={0.01}
                max={10_000}
                step={0.01}
                placeholder={t.maxCostHint}
              />
            </div>
          </fieldset>
          <div className="w-40">
            <NumberField
              label={t.maxTests}
              value={tests}
              onChange={setMaxTests}
              min={1}
              max={api.MAX_TESTS_LIMIT}
            />
          </div>
          {noBuilds && <p className="text-amber-800">{t.noBuilds}</p>}
          {devices.data && idle.length === 0 && <p className="text-amber-800">{t.noDevices}</p>}
          {start.isError && (
            <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-red-800">
              {notConfigured ? (
                <>
                  {t.notConfigured}{' '}
                  <a href="/settings/brains" className="font-medium underline">
                    {t.configure}
                  </a>
                </>
              ) : (
                errorMessage(start.error)
              )}
            </p>
          )}
          <button
            type="submit"
            className={buttonClass.primary}
            disabled={!appId || !buildId || !deviceId || start.isPending}
          >
            {start.isPending ? t.starting : t.submit}
          </button>
        </form>
      </Card>
    </section>
  )
}
