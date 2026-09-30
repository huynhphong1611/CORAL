import { elementTreeSchema, type api } from '@coral/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { useState } from 'react'
import {
  isActive,
  keys,
  useCoral,
  useDevices,
  useProjects,
  useRole,
  useRun,
  useSteps,
  useWatchRuns,
} from '../../api/queries'
import { PageHeader } from '../../components/Layout'
import { TreeView } from '../../components/TreeView'
import {
  Badge,
  buttonClass,
  Card,
  elapsed,
  formatDuration,
  formatTime,
  QueryState,
  shortId,
  StatusBadge,
  useNow,
} from '../../components/ui'
import { en } from '../../i18n/en'

/** `/runs/$runId`: progress of every item and step, live while the run is active (FR-003). */
export function RunDetailPage() {
  const { runId } = useParams({ from: '/_app/runs/$runId' })
  const run = useRun(runId)
  const active = run.data ? isActive(run.data) : false
  useWatchRuns(active ? [runId] : [])

  return (
    <section>
      <nav aria-label="Breadcrumb" className="mb-2 text-sm text-slate-500">
        <Link to="/runs" className="hover:text-slate-800">
          {en.runs.back}
        </Link>
      </nav>
      <QueryState query={run} isEmpty={() => false}>
        {(data) => <RunView run={data} />}
      </QueryState>
    </section>
  )
}

function RunView({ run }: { run: api.Run }) {
  const { canWrite } = useRole()
  const projects = useProjects()
  const devices = useDevices()
  const project = projects.data?.find((p) => p.id === run.project_id)
  const device = devices.data?.find((d) => d.id === run.device_id)
  const active = isActive(run)
  const now = useNow(active)

  return (
    <>
      <PageHeader title={`${en.runs.run} ${shortId(run.id)}`}>
        <div className="flex items-center gap-3">
          {active && (
            <Badge tone="blue">
              <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />
              {en.runs.live}
            </Badge>
          )}
          <span data-testid="run-status">
            <StatusBadge status={run.status} />
          </span>
          {canWrite && active && <CancelRun runId={run.id} />}
        </div>
      </PageHeader>
      <Card className="mb-6 grid grid-cols-2 gap-x-8 gap-y-3 p-4 text-sm md:grid-cols-4">
        <Meta label={en.runs.project}>
          {project ? (
            <Link
              to="/projects/$projectId"
              params={{ projectId: project.id }}
              search={{ tab: 'runs' }}
              className={buttonClass.link}
            >
              {project.name}
            </Link>
          ) : (
            shortId(run.project_id)
          )}
        </Meta>
        <Meta label={en.runs.device}>{device ? `${device.model} · ${device.udid}` : '—'}</Meta>
        <Meta label={en.runs.build}>
          <span className="font-mono">{shortId(run.build_id)}</span>
        </Meta>
        <Meta label={en.runs.duration}>
          {run.started_at ? elapsed(run.started_at, run.finished_at, now) : '—'}
        </Meta>
        <Meta label={en.runs.queued}>{formatTime(run.queued_at)}</Meta>
        <Meta label={en.runs.started}>{formatTime(run.started_at)}</Meta>
        <Meta label={en.runs.finished}>{formatTime(run.finished_at)}</Meta>
        {run.failure_code && (
          <Meta label={en.runs.failure}>
            <span className="font-mono text-red-700">{run.failure_code}</span>
          </Meta>
        )}
      </Card>
      <div className="space-y-6">
        {run.items.map((item) => (
          <RunItemView key={item.id} run={run} item={item} />
        ))}
      </div>
    </>
  )
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-slate-900">{children}</div>
    </div>
  )
}

function CancelRun({ runId }: { runId: string }) {
  const { client } = useCoral()
  const queryClient = useQueryClient()
  const cancel = useMutation({
    mutationFn: () => client.post(`/runs/${runId}/cancel`, {}),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.run(runId) }),
  })
  return (
    <button
      type="button"
      className={buttonClass.secondary}
      disabled={cancel.isPending}
      onClick={() => cancel.mutate()}
    >
      {en.runs.cancel}
    </button>
  )
}

function RunItemView({ run, item }: { run: api.Run; item: api.RunItem }) {
  const started = item.status !== 'pending' && item.status !== 'skipped'
  return (
    <section aria-label={item.slug ?? item.test_case_id}>
      <div className="mb-3 flex items-center gap-3">
        <h2 className="font-mono text-base font-semibold">
          {en.runs.item(item.position, item.slug ?? shortId(item.test_case_id))}
        </h2>
        <StatusBadge status={item.status} />
        {item.failure_code && (
          <span className="font-mono text-xs text-red-700">
            {item.failure_code}
            {item.failed_step_id && ` @ ${item.failed_step_id}`}
          </span>
        )}
      </div>
      {started ? (
        <Steps runId={run.id} itemId={item.id} />
      ) : (
        <p className="text-sm text-slate-500">
          {item.status === 'pending' ? en.runs.waiting : en.runs.noSteps}
        </p>
      )}
    </section>
  )
}

function Steps({ runId, itemId }: { runId: string; itemId: string }) {
  const steps = useSteps(runId, itemId)
  return (
    <QueryState query={steps} empty={en.runs.noSteps}>
      {(list) => (
        <ol className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {list.map((step) => (
            <StepCard key={step.step_index} step={step} />
          ))}
        </ol>
      )}
    </QueryState>
  )
}

function StepCard({ step }: { step: api.RunStep }) {
  const [panel, setPanel] = useState<'log' | 'tree' | undefined>()
  const toggle = (next: 'log' | 'tree') =>
    setPanel((current) => (current === next ? undefined : next))
  return (
    <li
      aria-label={`Step ${step.step_id}`}
      className={`overflow-hidden rounded-lg border bg-white ${
        step.status === 'failed' ? 'border-red-300' : 'border-slate-200'
      }`}
    >
      <Screenshot url={step.artifacts.screenshot_url} stepId={step.step_id} />
      <div className="space-y-2 p-3 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-slate-900">
            {step.step_index + 1}. {step.step_id}
          </span>
          <StatusBadge status={step.status} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
          <span className="font-mono">{step.action}</span>
          <span>·</span>
          <span>
            {step.locator_used_index === null
              ? en.steps.noLocator
              : en.steps.locator(step.locator_used_index)}
          </span>
          <span>·</span>
          <span>{formatDuration(step.duration_ms)}</span>
          {step.degraded && <Badge tone="amber">{en.steps.degraded}</Badge>}
          {step.unstable && <Badge tone="amber">{en.steps.unstable}</Badge>}
        </div>
        {step.popups_handled.length > 0 && (
          <div className="text-xs text-slate-600">
            <span className="font-medium">{en.steps.popups}:</span>{' '}
            {step.popups_handled.map((p) => `${p.rule} → ${p.button}`).join(', ')}
          </div>
        )}
        {(step.failure_code || step.message) && (
          <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">
            {step.failure_code && <span className="font-mono">{step.failure_code}</span>}
            {step.failure_code && step.message && ': '}
            {step.message}
          </p>
        )}
        <div className="flex gap-3">
          {step.artifacts.log_url && (
            <button type="button" className={buttonClass.link} onClick={() => toggle('log')}>
              {panel === 'log' ? en.steps.hide : en.steps.showLog}
            </button>
          )}
          {step.artifacts.tree_url && (
            <button type="button" className={buttonClass.link} onClick={() => toggle('tree')}>
              {panel === 'tree' ? en.steps.hide : en.steps.showTree}
            </button>
          )}
        </div>
        {panel === 'log' && step.artifacts.log_url && <DeviceLog url={step.artifacts.log_url} />}
        {panel === 'tree' && step.artifacts.tree_url && <Tree url={step.artifacts.tree_url} />}
      </div>
    </li>
  )
}

/** Presigned step screenshot; a broken or missing one shows a frame instead (contracts/web-ui.md). */
function Screenshot({ url, stepId }: { url: string | null; stepId: string }) {
  const [broken, setBroken] = useState(false)
  if (!url || broken) {
    return (
      <div className="flex aspect-[9/16] max-h-80 w-full items-center justify-center bg-slate-100 text-xs text-slate-500">
        {url ? en.steps.imageUnavailable : en.steps.noImage}
      </div>
    )
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" className="block bg-slate-900">
      <img
        src={url}
        alt={en.steps.screenshotOf(stepId)}
        onError={() => setBroken(true)}
        className="mx-auto max-h-80 object-contain"
      />
    </a>
  )
}

async function fetchArtifact(url: string): Promise<Response> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response
}

function DeviceLog({ url }: { url: string }) {
  const log = useQuery({
    queryKey: ['artifact', 'log', url],
    queryFn: async () => (await fetchArtifact(url)).text(),
    staleTime: Infinity,
  })
  return (
    <QueryState query={log} isEmpty={(text) => text.trim() === ''} empty={en.steps.logEmpty}>
      {(text) => (
        <pre className="max-h-64 overflow-auto rounded bg-slate-900 p-2 text-[11px] leading-snug text-slate-100">
          {text.split('\n').slice(-200).join('\n')}
        </pre>
      )}
    </QueryState>
  )
}

function Tree({ url }: { url: string }) {
  const tree = useQuery({
    queryKey: ['artifact', 'tree', url],
    queryFn: async () => elementTreeSchema.parse(await (await fetchArtifact(url)).json()),
    staleTime: Infinity,
  })
  return (
    <div className="max-h-80 overflow-auto rounded border border-slate-200 p-2">
      <QueryState query={tree}>{(windows) => <TreeView windows={windows} />}</QueryState>
    </div>
  )
}
