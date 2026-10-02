import type { api } from '@coral/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { importKeys, isImporting, useImport, useWatchImport } from '../../api/imports'
import { useCoral, useDevices, useProjects, useRole } from '../../api/queries'
import { PageHeader } from '../../components/Layout'
import {
  Badge,
  buttonClass,
  Card,
  elapsed,
  errorMessage,
  formatTime,
  QueryState,
  Table,
  Td,
  Th,
  useNow,
} from '../../components/ui'
import { en } from '../../i18n/en'
import { costOfBudget } from '../explorations/describe'
import { IMPORT_TONES, ITEM_TONES } from './ImportsTab'

const t = en.imports

/**
 * `/imports/$importId` (contracts/web-ui-phase3.md, US6): the job live — how many cases are done,
 * active and draft, its cost against the budget, Cancel — and each case with its status, why it
 * stayed draft (with the step and picture that show it) and the test case it became.
 */
export function ImportPage() {
  const { importId } = useParams({ from: '/_app/imports/$importId' })
  const job = useImport(importId)
  return (
    <section>
      <QueryState query={job} isEmpty={() => false}>
        {(data) => <ImportView job={data} />}
      </QueryState>
    </section>
  )
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-slate-800">{children}</div>
    </div>
  )
}

function ImportView({ job }: { job: api.ImportJobDetail }) {
  const active = isImporting(job)
  useWatchImport(job.id, active)
  const { canWrite } = useRole()
  const project = useProjects().data?.find((p) => p.id === job.project_id)
  const device = useDevices().data?.find((d) => d.id === job.device_id)
  const now = useNow(active)
  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-2 text-sm text-slate-500">
        <Link
          to="/projects/$projectId"
          params={{ projectId: job.project_id }}
          search={{ tab: 'imports' }}
          className="hover:text-slate-800"
        >
          {project?.name ?? t.back}
        </Link>
      </nav>
      <PageHeader title={t.title(job.file_name)}>
        <div className="flex items-center gap-3">
          <span data-testid="import-status">
            <Badge tone={IMPORT_TONES[job.status]}>{job.status}</Badge>
          </span>
          {canWrite && active && <CancelButton id={job.id} />}
        </div>
      </PageHeader>
      <Card className="mb-4 grid grid-cols-2 gap-x-8 gap-y-3 p-4 text-sm md:grid-cols-4">
        <Meta label={t.project}>{project?.name ?? '—'}</Meta>
        <Meta label={t.device}>{device ? `${device.model} · ${device.udid}` : '—'}</Meta>
        <Meta label={t.started}>{formatTime(job.started_at)}</Meta>
        <Meta label={t.duration}>
          {job.started_at ? elapsed(job.started_at, job.finished_at, now) : '—'}
        </Meta>
        <Meta label={t.done}>
          <span data-testid="import-progress">
            {job.stats.done} / {job.stats.total}
          </span>
        </Meta>
        <Meta label={t.active}>{job.stats.active}</Meta>
        <Meta label={t.draft}>{job.stats.draft}</Meta>
        <Meta label={t.cost}>
          {job.budget ? costOfBudget(job.stats.cost_usd, job.budget.max_cost_usd) : '—'}
        </Meta>
      </Card>
      {job.report && <Report report={job.report} />}
      <Items job={job} />
    </>
  )
}

function CancelButton({ id }: { id: string }) {
  const { client } = useCoral()
  const queryClient = useQueryClient()
  const cancel = useMutation({
    mutationFn: () => client.post(`/imports/${id}/cancel`, {}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: importKeys.one(id) }),
  })
  return (
    <>
      <button
        type="button"
        className={buttonClass.secondary}
        disabled={cancel.isPending}
        onClick={() => window.confirm(t.confirmCancel) && cancel.mutate()}
      >
        {cancel.isPending ? t.cancelling : t.cancel}
      </button>
      {cancel.isError && (
        <span role="alert" className="text-sm text-red-700">
          {errorMessage(cancel.error)}
        </span>
      )}
    </>
  )
}

/** Once the job ended: how many became active, why the others stayed draft. */
function Report({ report }: { report: api.ImportReport }) {
  const reasons = (Object.entries(report.draft) as [api.ImportItemReason, number][]).filter(
    ([, n]) => n > 0,
  )
  return (
    <Card className="mb-4 space-y-2 p-4 text-sm" data-testid="import-report">
      <h2 className="font-medium">{t.report}</h2>
      <p>{t.reportLine(report.active, report.total)}</p>
      <ul className="flex flex-wrap gap-2">
        {reasons.map(([reason, n]) => (
          <li key={reason}>
            <Badge tone="amber">
              {t.reasons[reason]}: {n}
            </Badge>
          </li>
        ))}
        {report.not_processed > 0 && (
          <li>
            <Badge tone="slate">
              {t.notProcessed}: {report.not_processed}
            </Badge>
          </li>
        )}
      </ul>
    </Card>
  )
}

function Items({ job }: { job: api.ImportJobDetail }) {
  return (
    <Table label={t.itemsTable}>
      <thead>
        <tr>
          <Th className="w-10">{t.item.n}</Th>
          <Th>{t.item.title}</Th>
          <Th>{t.item.status}</Th>
          <Th>{t.item.why}</Th>
          <Th>{t.item.testCase}</Th>
        </tr>
      </thead>
      <tbody>
        {job.items.map((item) => (
          <tr key={item.n}>
            <Td className="font-mono text-slate-500">{item.n}</Td>
            <Td className="max-w-xs">{item.title}</Td>
            <Td>
              <Badge tone={ITEM_TONES[item.status]}>{item.status}</Badge>
            </Td>
            <Td className="max-w-sm space-y-1">
              {item.reason && <Badge tone="amber">{t.reasons[item.reason]}</Badge>}
              {item.evidence && (
                <div className="text-xs text-slate-600">
                  {item.evidence.message}
                  {item.evidence.step_n !== undefined && item.exploration_id && (
                    <>
                      {' · '}
                      <Link
                        to="/explorations/$explorationId"
                        params={{ explorationId: item.exploration_id }}
                        search={{ tab: 'trace' }}
                        className={buttonClass.link}
                      >
                        {t.step(item.evidence.step_n)}
                      </Link>
                    </>
                  )}
                </div>
              )}
              {item.evidence?.screenshot_url && (
                <a href={item.evidence.screenshot_url} target="_blank" rel="noreferrer">
                  <img
                    src={item.evidence.screenshot_url}
                    alt={t.picture}
                    className="max-h-32 rounded border border-slate-200"
                  />
                </a>
              )}
            </Td>
            <Td>
              {item.test_case_id ? (
                <Link
                  to="/projects/$projectId/testcases/$testCaseId"
                  params={{ projectId: job.project_id, testCaseId: item.test_case_id }}
                  className={buttonClass.link}
                >
                  {t.open}
                </Link>
              ) : (
                '—'
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  )
}
