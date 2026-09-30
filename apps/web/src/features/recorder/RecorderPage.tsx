import { api, type ExpectCondition, type protocol } from '@coral/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { ApiError } from '../../api/client'
import { recordingKeys, useRecorder, type RecorderNotice } from '../../api/recordings'
import { useCoral, useDevices, useRole } from '../../api/queries'
import { DeviceActions } from '../../components/DeviceActions'
import { PageHeader } from '../../components/Layout'
import { LiveView } from '../../components/LiveView'
import { Badge, buttonClass, Card, errorMessage, inputClass, QueryState } from '../../components/ui'
import { en } from '../../i18n/en'
import { locatorLabel } from './describe'
import { StepList } from './StepList'

type Inspected = protocol.UiPayload<'live.inspected'>

const STATUS_TONES = {
  recording: 'red',
  stopped: 'amber',
  saved: 'green',
  discarded: 'slate',
  expired: 'slate',
} as const

/**
 * `/recordings/$recordingId` — the Recorder (US4, contracts/web-ui.md): the device's live view
 * where every click, drag or hold becomes a step (Assert mode instead adds an expectation), the
 * recorded steps, and slug / intent / YAML preview / Save as test case. Everything lives on the
 * server, so a reload restores the recording (FR-016).
 */
export function RecorderPage() {
  const { recordingId } = useParams({ from: '/_app/recordings/$recordingId' })
  const recorder = useRecorder(recordingId)
  return (
    <QueryState query={recorder.recording}>
      {(recording) => <Recorder recording={recording} recorder={recorder} />}
    </QueryState>
  )
}

function Recorder({
  recording,
  recorder,
}: {
  recording: api.Recording
  recorder: ReturnType<typeof useRecorder>
}) {
  const { session } = useCoral()
  const me = useSyncExternalStore(session.subscribe, session.getSnapshot).session?.user.id
  const { canWrite } = useRole()
  const device = useDevices().data?.find((d) => d.id === recording.device_id)
  const canEdit =
    canWrite &&
    recording.created_by.id === me &&
    (recording.status === 'recording' || recording.status === 'stopped')
  const recordingNow = canEdit && recording.status === 'recording'
  const [assert, setAssert] = useState(false)
  const [inspected, setInspected] = useState<Inspected | undefined>()
  const [errors, setErrors] = useState<ReadonlyMap<string, readonly string[]>>(new Map())
  const { steps, send, inspect, addExpect, removeStep, moveStep, notice } = recorder
  const last = steps.at(-1)

  async function gesture(command: protocol.DeviceCommand) {
    if (!assert) return send(command)
    if (command.kind !== 'tap') return
    setInspected(await inspect(command.x, command.y))
  }
  function pick(condition: ExpectCondition) {
    if (last) addExpect(last.n, condition)
    setInspected(undefined)
  }

  return (
    <section>
      <nav aria-label="Breadcrumb" className="mb-2 text-sm text-slate-500">
        <Link
          to="/projects/$projectId"
          params={{ projectId: recording.project_id }}
          search={{ tab: 'recordings' }}
          className="hover:text-slate-800"
        >
          {en.recorder.back}
        </Link>
      </nav>
      <PageHeader title={en.recorder.title(recording.slug)}>
        <Badge tone={STATUS_TONES[recording.status]}>{recording.status}</Badge>
      </PageHeader>
      <div className="flex flex-col gap-6 xl:flex-row xl:items-start">
        <LiveView
          deviceId={recording.device_id}
          {...(recordingNow ? { onGesture: (command) => void gesture(command) } : {})}
        />
        <div className="flex w-full flex-col gap-4 xl:w-80">
          <Card className="space-y-3 p-4 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-600">{device?.model ?? recording.device_id}</span>
              {canEdit && <Lifecycle recording={recording} recorder={recorder} />}
            </div>
            {recording.status === 'stopped' && (
              <p className="text-amber-800">{en.recorder.stopped}</p>
            )}
            {!canEdit && recording.status !== 'recording' && recording.status !== 'stopped' && (
              <p className="text-slate-600">{en.recorder.closed(recording.status)}</p>
            )}
            {recordingNow && (
              <>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={assert}
                    onChange={(e) => {
                      setAssert(e.target.checked)
                      setInspected(undefined)
                    }}
                  />
                  <span className="font-medium">{en.recorder.assertMode}</span>
                </label>
                <p className="text-xs text-slate-500">
                  {assert ? en.recorder.assertHint : en.recorder.hint}
                </p>
                {inspected && (
                  <InspectPanel
                    inspected={inspected}
                    onPick={pick}
                    onCancel={() => setInspected(undefined)}
                  />
                )}
                <DeviceActions
                  send={(command) =>
                    send(command, command.kind !== 'home' && command.kind !== 'restart_app')
                  }
                />
                <p className="text-xs text-slate-500">{en.recorder.notRecorded}</p>
              </>
            )}
            {notice && <Notice notice={notice} />}
          </Card>
        </div>
        <div className="w-full min-w-0 flex-1 space-y-4">
          <Card className="p-4">
            <h2 className="mb-3 text-sm font-medium">{en.recorder.steps}</h2>
            <StepList
              steps={steps}
              errors={errors}
              canEdit={canEdit}
              onAccept={addExpect}
              onDelete={removeStep}
              onMove={moveStep}
            />
          </Card>
          <SavePanel
            recording={recording}
            recorder={recorder}
            canEdit={canEdit}
            onErrors={setErrors}
          />
        </div>
      </div>
    </section>
  )
}

function Notice({ notice }: { notice: RecorderNotice }) {
  const text =
    notice.kind === 'popup'
      ? en.recorder.popup(notice.rule)
      : notice.kind === 'secret'
        ? en.recorder.secret(notice.name)
        : notice.kind === 'ended'
          ? en.recorder.ended[notice.reason]
          : notice.message
  const tone = notice.kind === 'error' ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-800'
  return (
    <p
      role={notice.kind === 'error' ? 'alert' : 'status'}
      className={`rounded-md px-3 py-2 ${tone}`}
    >
      {text}
    </p>
  )
}

/** Assert mode: what is under the click, and the expectations it can give the last step. */
function InspectPanel({
  inspected,
  onPick,
  onCancel,
}: {
  inspected: Inspected
  onPick: (condition: ExpectCondition) => void
  onCancel: () => void
}) {
  const locator = inspected.locators[0]
  return (
    <div
      className="space-y-2 rounded-md border border-emerald-300 bg-emerald-50 p-3"
      data-testid="inspected"
    >
      <p className="text-xs text-slate-600">
        {inspected.element.class.split('.').at(-1)}
        {locator && ` · ${locatorLabel(locator)}`}
      </p>
      <div className="flex flex-wrap gap-2">
        {inspected.text && (
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() => onPick({ visible_text: inspected.text })}
          >
            {en.recorder.expectText(inspected.text)}
          </button>
        )}
        {locator && (
          <>
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => onPick({ visible: locator })}
            >
              {en.recorder.expectVisible}
            </button>
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => onPick({ not_visible: locator })}
            >
              {en.recorder.expectNotVisible}
            </button>
          </>
        )}
        <button type="button" className={buttonClass.link} onClick={onCancel}>
          {en.recorder.cancel}
        </button>
      </div>
    </div>
  )
}

function Lifecycle({
  recording,
  recorder,
}: {
  recording: api.Recording
  recorder: ReturnType<typeof useRecorder>
}) {
  const { client } = useCoral()
  const navigate = useNavigate()
  const discard = useMutation({
    mutationFn: () => client.delete(`/recordings/${recording.id}`),
    onSuccess: () =>
      navigate({
        to: '/projects/$projectId',
        params: { projectId: recording.project_id },
        search: { tab: 'recordings' },
      }),
    onError: (error) => recorder.setNotice({ kind: 'error', message: errorMessage(error) }),
  })
  return (
    <div className="flex gap-2">
      {recording.status === 'recording' ? (
        <button
          type="button"
          className={buttonClass.secondary}
          onClick={() => void recorder.stop()}
        >
          {en.recorder.stop}
        </button>
      ) : (
        <button
          type="button"
          className={buttonClass.secondary}
          onClick={() => void recorder.resume()}
        >
          {en.recorder.resume}
        </button>
      )}
      <button
        type="button"
        className={buttonClass.secondary}
        disabled={discard.isPending}
        onClick={() => window.confirm(en.recorder.confirmDiscard) && discard.mutate()}
      >
        {en.recorder.discard}
      </button>
    </div>
  )
}

/** Slug, intent, YAML preview (read only, FR-016) and Save as test case (FR-017). */
function SavePanel({
  recording,
  recorder,
  canEdit,
  onErrors,
}: {
  recording: api.Recording
  recorder: ReturnType<typeof useRecorder>
  canEdit: boolean
  onErrors: (errors: ReadonlyMap<string, readonly string[]>) => void
}) {
  const { client } = useCoral()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [slug, setSlug] = useState(recording.slug)
  const [intent, setIntent] = useState(recording.intent)
  const [preview, setPreview] = useState<api.RecordingYaml | undefined>()
  const [problem, setProblem] = useState<string | undefined>()
  const [exists, setExists] = useState(false)
  useEffect(() => setSlug(recording.slug), [recording.slug])
  useEffect(() => setIntent(recording.intent), [recording.intent])

  /**
   * The YAML of the steps with the slug and intent as typed — stored first, even while a field
   * still has the focus (its blur PATCH may not have landed yet).
   */
  const yaml = async () => {
    if (canEdit && (slug !== recording.slug || intent !== recording.intent)) {
      const updated = await client.patch(
        `/recordings/${recording.id}`,
        { slug, intent },
        api.recordingSchema,
      )
      queryClient.setQueryData(recordingKeys.one(recording.id), updated)
    }
    return client.get(`/recordings/${recording.id}/yaml`, api.recordingYamlSchema)
  }
  const commit = (field: 'slug' | 'intent', value: string) => {
    if (value !== recording[field]) recorder.patch.mutate({ [field]: value })
  }

  const save = useMutation({
    mutationFn: async (replace: boolean) => {
      const { yaml: source } = await yaml()
      const base = replace
        ? (
            await client.get(
              `/projects/${recording.project_id}/testcases`,
              api.testCaseSummarySchema.array(),
            )
          ).find((t) => t.slug === slug)?.head_commit
        : undefined
      return client.post(
        `/recordings/${recording.id}/save`,
        { slug, intent, yaml: source, ...(base ? { replace: true, base_commit: base } : {}) },
        api.savedRecordingSchema,
      )
    },
    onMutate: () => {
      setProblem(undefined)
      onErrors(new Map())
    },
    onSuccess: () =>
      navigate({
        to: '/projects/$projectId',
        params: { projectId: recording.project_id },
        search: { tab: 'testcases' },
      }),
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'slug_exists') {
        setExists(true)
        setProblem(en.recorder.slugExists(slug))
        return
      }
      setProblem(errorMessage(error))
      if (error instanceof ApiError && Array.isArray(error.details)) {
        const byStep = new Map<string, string[]>()
        for (const issue of error.details) {
          if (!issue.step_id) continue
          byStep.set(issue.step_id, [
            ...(byStep.get(issue.step_id) ?? []),
            `${issue.code}: ${issue.message}`,
          ])
        }
        onErrors(byStep)
      }
    },
  })

  return (
    <Card className="space-y-3 p-4 text-sm">
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <label className="space-y-1">
          <span className="font-medium">{en.recorder.slug}</span>
          <input
            className={`${inputClass} w-full font-mono`}
            value={slug}
            disabled={!canEdit}
            onChange={(e) => {
              setSlug(e.target.value.toLowerCase())
              setExists(false)
            }}
            onBlur={() => commit('slug', slug)}
          />
        </label>
        <label className="space-y-1">
          <span className="font-medium">{en.recorder.intent}</span>
          <input
            className={`${inputClass} w-full`}
            value={intent}
            placeholder={en.recorder.intentPlaceholder}
            disabled={!canEdit}
            onChange={(e) => setIntent(e.target.value)}
            onBlur={() => commit('intent', intent)}
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonClass.secondary}
          onClick={() =>
            preview
              ? setPreview(undefined)
              : void yaml()
                  .then(setPreview)
                  .catch((error: unknown) => setProblem(errorMessage(error)))
          }
        >
          {preview ? en.recorder.hidePreview : en.recorder.preview}
        </button>
        {canEdit && (
          <button
            type="button"
            className={buttonClass.primary}
            disabled={save.isPending || !slug || !intent.trim()}
            onClick={() => save.mutate(false)}
          >
            {save.isPending ? en.recorder.saving : en.recorder.save}
          </button>
        )}
        {canEdit && exists && (
          <button type="button" className={buttonClass.secondary} onClick={() => save.mutate(true)}>
            {en.recorder.replace(slug)}
          </button>
        )}
      </div>
      {problem && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-red-800">
          {problem}
        </p>
      )}
      {preview && (
        <div className="space-y-2">
          <pre
            data-testid="yaml-preview"
            className="max-h-96 overflow-auto rounded-md bg-slate-900 p-3 font-mono text-xs text-slate-100"
          >
            {preview.yaml}
          </pre>
          {preview.warnings.length > 0 && (
            <ul className="space-y-0.5 text-xs text-amber-800">
              {preview.warnings.map((w) => (
                <li key={`${w.path}-${w.code}`}>
                  {w.step_id ? `${w.step_id}: ` : ''}
                  {w.code} — {w.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  )
}
