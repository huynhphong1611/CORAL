import { api, type ImportMapping } from '@coral/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react'
import { ApiError } from '../../api/client'
import { importKeys } from '../../api/imports'
import { useApps, useBuilds, useCoral, useDevices, useProjects } from '../../api/queries'
import { PageHeader } from '../../components/Layout'
import {
  buttonClass,
  Card,
  errorMessage,
  formatTime,
  inputClass,
  Table,
  Td,
  Th,
} from '../../components/ui'
import { en } from '../../i18n/en'

const t = en.imports

/**
 * `/projects/$projectId/imports/new` (contracts/web-ui-phase3.md, US6): a file is read into a
 * preview — its columns (chosen again when guessed wrong), the test cases and the rows left out
 * with why — then app, build, device and budget, and Start; or the file is discarded.
 */
export function NewImportPage() {
  const { projectId } = useParams({ from: '/_app/projects/$projectId/imports/new' })
  const { client } = useCoral()
  const navigate = useNavigate()
  const project = useProjects().data?.find((p) => p.id === projectId)
  const fileId = useId()
  const [file, setFile] = useState<File | undefined>()
  const [sheet, setSheet] = useState('')
  const [preview, setPreview] = useState<api.ImportPreview | undefined>()

  const upload = useMutation({
    mutationFn: (chosen: File) => {
      const form = new FormData()
      form.set('file', chosen, chosen.name)
      if (sheet.trim()) form.set('sheet', sheet.trim())
      return client.upload(`/projects/${projectId}/imports`, form, api.importPreviewSchema)
    },
    onSuccess: setPreview,
  })
  const discard = useMutation({
    mutationFn: (id: string) => client.delete(`/imports/${id}`),
    onSuccess: () => {
      setPreview(undefined)
      void navigate({
        to: '/projects/$projectId',
        params: { projectId },
        search: { tab: 'imports' },
      })
    },
  })

  function read(event: FormEvent) {
    event.preventDefault()
    if (file) upload.mutate(file)
  }

  return (
    <section>
      <nav aria-label="Breadcrumb" className="mb-2 text-sm text-slate-500">
        <Link
          to="/projects/$projectId"
          params={{ projectId }}
          search={{ tab: 'imports' }}
          className="hover:text-slate-800"
        >
          {project?.name ?? t.back}
        </Link>
      </nav>
      <PageHeader title={t.newTitle} />
      <div className="space-y-4">
        <Card className="max-w-xl p-5">
          <form onSubmit={read} className="space-y-4 text-sm">
            <p className="text-slate-600">{t.newSubtitle}</p>
            <label htmlFor={fileId} className="block space-y-1">
              <span className="font-medium">{t.chooseFile}</span>
              <input
                id={fileId}
                type="file"
                accept=".csv,.tsv,.txt,.xlsx,.feature"
                className="block w-full text-sm"
                disabled={preview !== undefined}
                onChange={(e) => setFile(e.target.files?.[0])}
              />
            </label>
            {file?.name.toLowerCase().endsWith('.xlsx') && (
              <label className="block space-y-1">
                <span className="font-medium">{t.sheet}</span>
                <input
                  className={`${inputClass} w-full`}
                  value={sheet}
                  placeholder={t.sheetHint}
                  disabled={preview !== undefined}
                  onChange={(e) => setSheet(e.target.value)}
                />
              </label>
            )}
            {upload.isError && (
              <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-red-800">
                {errorMessage(upload.error)}
              </p>
            )}
            {!preview && (
              <button
                type="submit"
                className={buttonClass.primary}
                disabled={!file || upload.isPending}
              >
                {upload.isPending ? t.reading : t.read}
              </button>
            )}
          </form>
        </Card>
        {preview && (
          <>
            {preview.format !== 'gherkin' && preview.columns.length > 0 && (
              <ColumnsCard preview={preview} onRead={setPreview} />
            )}
            <PreviewCard preview={preview} />
            <StartCard
              projectId={projectId}
              preview={preview}
              discarding={discard.isPending}
              onDiscard={() =>
                window.confirm(t.confirmDiscard) && discard.mutate(preview.import_job_id)
              }
            />
          </>
        )}
      </div>
    </section>
  )
}

type Draft = Partial<Pick<ImportMapping, 'title' | 'preconditions' | 'id'>> &
  Pick<ImportMapping, 'steps' | 'expected' | 'header_row'>

/** Which column holds what; read again under the columns chosen (`PATCH /imports/:id`). */
function ColumnsCard({
  preview,
  onRead,
}: {
  preview: api.ImportPreview
  onRead: (preview: api.ImportPreview) => void
}) {
  const { client } = useCoral()
  const [draft, setDraft] = useState<Draft>(
    () => preview.mapping ?? { steps: [], expected: [], header_row: 0 },
  )
  const remap = useMutation({
    mutationFn: (mapping: ImportMapping) =>
      client.patch(`/imports/${preview.import_job_id}`, { mapping }, api.importPreviewSchema),
    onSuccess: onRead,
  })
  const single = (field: 'title' | 'preconditions' | 'id', optional: boolean) => (
    <label className="block space-y-1">
      <span className="text-xs text-slate-600">{t.fields[field]}</span>
      <select
        aria-label={t.fields[field]}
        className={`${inputClass} w-full`}
        value={draft[field] ?? ''}
        onChange={(e) => {
          const value = e.target.value === '' ? undefined : Number(e.target.value)
          setDraft((d) => {
            const next = { ...d }
            if (value === undefined) delete next[field]
            else next[field] = value
            return next
          })
        }}
      >
        {optional || draft[field] === undefined ? <option value="">{t.none}</option> : null}
        {preview.columns.map((c) => (
          <option key={c.index} value={c.index}>
            {c.header || `#${c.index + 1}`}
          </option>
        ))}
      </select>
    </label>
  )
  const many = (field: 'steps' | 'expected') => (
    <fieldset className="space-y-1">
      <legend className="text-xs text-slate-600">{t.fields[field]}</legend>
      {preview.columns.map((c) => (
        <label key={c.index} className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={draft[field].includes(c.index)}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                [field]: e.target.checked
                  ? [...d[field], c.index].sort((a, b) => a - b)
                  : d[field].filter((i) => i !== c.index),
              }))
            }
          />
          {c.header || `#${c.index + 1}`}
        </label>
      ))}
    </fieldset>
  )
  const { title } = draft
  const complete = title !== undefined && draft.steps.length > 0
  return (
    <Card className="space-y-3 p-5 text-sm">
      <div>
        <h2 className="font-medium">{t.columns}</h2>
        <p className="text-slate-500">{t.columnsHint}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-5">
        {single('title', false)}
        {many('steps')}
        {many('expected')}
        {single('preconditions', true)}
        {single('id', true)}
      </div>
      <div className="flex items-end gap-3">
        <label className="block w-32 space-y-1">
          <span className="text-xs text-slate-600">{t.headerRow}</span>
          <input
            type="number"
            min={1}
            className={`${inputClass} w-full`}
            value={draft.header_row + 1}
            onChange={(e) =>
              setDraft((d) => ({ ...d, header_row: Math.max(0, Number(e.target.value) - 1) }))
            }
          />
        </label>
        <button
          type="button"
          className={buttonClass.secondary}
          disabled={!complete || remap.isPending}
          onClick={() => title !== undefined && remap.mutate({ ...draft, title })}
        >
          {t.readAgain}
        </button>
      </div>
      {remap.isError && (
        <p role="alert" className="text-red-700">
          {errorMessage(remap.error)}
        </p>
      )}
    </Card>
  )
}

/** The test cases read and the rows left out, with where and why. */
function PreviewCard({ preview }: { preview: api.ImportPreview }) {
  return (
    <Card className="space-y-3 p-5 text-sm">
      <h2 className="font-medium" data-testid="import-cases-count">
        {t.cases(preview.cases.length)}
      </h2>
      {preview.errors.length > 0 && (
        <div>
          <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">{t.errors}</h3>
          <ul aria-label={t.errors} className="mt-1 space-y-0.5 text-amber-800">
            {preview.errors.map((issue, i) => (
              <li key={`${issue.row ?? issue.line ?? 0}-${issue.code}-${i}`}>
                <span className="font-mono">{t.at(issue)}</span> · {issue.code}: {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {preview.cases.length > 0 && (
        <Table label={t.casesTable}>
          <thead>
            <tr>
              <Th>{t.fields.id}</Th>
              <Th>{t.fields.title}</Th>
              <Th>{t.fields.steps}</Th>
            </tr>
          </thead>
          <tbody>
            {preview.cases.map((manual) => (
              <tr key={`${manual.id}-${manual.source.row ?? manual.source.line ?? 0}`}>
                <Td className="font-mono text-slate-500">{manual.id}</Td>
                <Td className="max-w-xs">
                  {manual.title}
                  {manual.preconditions.length > 0 && (
                    <div className="mt-0.5 text-xs text-slate-500">
                      {manual.preconditions.join(' · ')}
                    </div>
                  )}
                </Td>
                <Td>
                  <ol className="list-decimal space-y-0.5 pl-4 text-slate-700">
                    {manual.steps.map((step, i) => (
                      <li key={i}>
                        {step.action}
                        {step.expected && (
                          <span className="text-slate-500"> → {step.expected}</span>
                        )}
                      </li>
                    ))}
                  </ol>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  )
}

const asNumber = (value: string) => (value.trim() === '' ? undefined : Number(value))

/** App, build, idle device and budget; then the job starts and its page opens. */
function StartCard({
  projectId,
  preview,
  discarding,
  onDiscard,
}: {
  projectId: string
  preview: api.ImportPreview
  discarding: boolean
  onDiscard: () => void
}) {
  const { client } = useCoral()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const apps = useApps(projectId)
  const devices = useDevices()
  const [appId, setAppId] = useState<string | undefined>()
  const [buildId, setBuildId] = useState<string | undefined>()
  const [deviceId, setDeviceId] = useState<string | undefined>()
  const [maxCost, setMaxCost] = useState('')
  const [maxMinutes, setMaxMinutes] = useState(String(api.DEFAULT_IMPORT_MINUTES))
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

  const start = useMutation({
    mutationFn: () => {
      const cost = asNumber(maxCost)
      const minutes = asNumber(maxMinutes)
      return client.post(
        `/imports/${preview.import_job_id}/start`,
        {
          app_id: appId,
          build_id: buildId,
          device_id: deviceId,
          budget: {
            ...(cost !== undefined ? { max_cost_usd: cost } : {}),
            ...(minutes !== undefined ? { max_minutes: minutes } : {}),
          },
        },
        api.importJobSchema,
      )
    },
    onSuccess: (job) => {
      void queryClient.invalidateQueries({ queryKey: importKeys.list(projectId) })
      void navigate({ to: '/imports/$importId', params: { importId: job.id } })
    },
  })
  const notConfigured =
    start.error instanceof ApiError && start.error.code === 'brains_not_configured'
  return (
    <Card className="max-w-xl p-5">
      <form
        className="space-y-4 text-sm"
        onSubmit={(e) => {
          e.preventDefault()
          start.mutate()
        }}
      >
        <div>
          <h2 className="font-medium">{t.run}</h2>
          <p className="text-slate-500">{t.runHint}</p>
        </div>
        <label className="block space-y-1">
          <span className="font-medium">{en.exploreStart.app}</span>
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
          <span className="font-medium">{en.exploreStart.build}</span>
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
          <span className="font-medium">{en.exploreStart.device}</span>
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
        <fieldset className="grid grid-cols-2 gap-3">
          <legend className="mb-1 font-medium">{en.exploreStart.budget}</legend>
          <label className="block space-y-1">
            <span className="text-xs text-slate-600">{t.maxCost}</span>
            <input
              type="number"
              min={0.01}
              step={0.01}
              className={`${inputClass} w-full`}
              value={maxCost}
              placeholder={t.maxCostHint}
              onChange={(e) => setMaxCost(e.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-slate-600">{t.maxMinutes}</span>
            <input
              type="number"
              min={1}
              max={1440}
              className={`${inputClass} w-full`}
              value={maxMinutes}
              onChange={(e) => setMaxMinutes(e.target.value)}
            />
          </label>
        </fieldset>
        {preview.cases.length === 0 && <p className="text-amber-800">{t.noCases}</p>}
        {devices.data && idle.length === 0 && (
          <p className="text-amber-800">{en.exploreStart.noDevices}</p>
        )}
        {start.isError && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-red-800">
            {notConfigured ? en.exploreStart.notConfigured : errorMessage(start.error)}
          </p>
        )}
        <div className="flex gap-2">
          <button
            type="submit"
            className={buttonClass.primary}
            disabled={
              !appId || !buildId || !deviceId || preview.cases.length === 0 || start.isPending
            }
          >
            {start.isPending ? t.starting : t.start}
          </button>
          <button
            type="button"
            className={buttonClass.secondary}
            disabled={discarding}
            onClick={onDiscard}
          >
            {t.discard}
          </button>
        </div>
      </form>
    </Card>
  )
}
