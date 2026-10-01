import type { api } from '@coral/shared'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import {
  isExploring,
  useExploration,
  useExplorationSteps,
  useStopExploration,
  useWatchExploration,
} from '../../api/explorations'
import { useDevices, useProjects, useRole } from '../../api/queries'
import { PageHeader } from '../../components/Layout'
import { LiveView } from '../../components/LiveView'
import {
  Badge,
  buttonClass,
  Card,
  elapsed,
  errorMessage,
  formatTime,
  QueryState,
  shortId,
  Table,
  Tabs,
  Td,
  Th,
  useNow,
} from '../../components/ui'
import { en } from '../../i18n/en'
import { costOfBudget, describeStep, EXPLORATION_TONES, STEP_TONES, usd } from './describe'
import { StepDetail } from './StepDetail'

const t = en.exploration

export const EXPLORATION_TABS = ['progress', 'appmap', 'trace', 'findings', 'testcases'] as const
export type ExplorationTab = (typeof EXPLORATION_TABS)[number]

/**
 * `/explorations/$explorationId` (contracts/web-ui-phase3.md): live progress while it runs (the
 * device's live view, read-only), then the app map it built, its trace with what the AI saw and
 * answered at each step, the crashes it met and the test cases it wrote.
 */
export function ExplorationPage() {
  const { explorationId } = useParams({ from: '/_app/explorations/$explorationId' })
  const exploration = useExploration(explorationId)
  return (
    <section>
      <QueryState query={exploration} isEmpty={() => false}>
        {(data) => <ExplorationView exploration={data} />}
      </QueryState>
    </section>
  )
}

function ExplorationView({ exploration }: { exploration: api.ExplorationDetail }) {
  const { tab } = useSearch({ from: '/_app/explorations/$explorationId' })
  const navigate = useNavigate({ from: '/explorations/$explorationId' })
  const { canWrite } = useRole()
  const active = isExploring(exploration)
  const current = useWatchExploration(exploration.id, active)
  const steps = useExplorationSteps(exploration.id)
  const project = useProjects().data?.find((p) => p.id === exploration.project_id)
  const device = useDevices().data?.find((d) => d.id === exploration.device_id)
  const now = useNow(active)

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-2 text-sm text-slate-500">
        <Link
          to="/projects/$projectId"
          params={{ projectId: exploration.project_id }}
          search={{ tab: 'explorations' }}
          className="hover:text-slate-800"
        >
          {project?.name ?? t.back}
        </Link>
      </nav>
      <PageHeader title={`${t.title} ${shortId(exploration.id)}`}>
        <div className="flex items-center gap-3">
          {active && (
            <Badge tone="blue">
              <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />
              {t.live}
            </Badge>
          )}
          <span data-testid="exploration-status">
            <Badge tone={EXPLORATION_TONES[exploration.status]}>{exploration.status}</Badge>
          </span>
          {canWrite && exploration.status === 'running' && <StopButton id={exploration.id} />}
        </div>
      </PageHeader>
      <Card className="mb-4 grid grid-cols-2 gap-x-8 gap-y-3 p-4 text-sm md:grid-cols-4">
        <Meta label={t.project}>{project?.name ?? shortId(exploration.project_id)}</Meta>
        <Meta label={t.device}>{device ? `${device.model} · ${device.udid}` : '—'}</Meta>
        <Meta label={t.started}>{formatTime(exploration.started_at)}</Meta>
        <Meta label={t.duration}>
          {exploration.started_at
            ? elapsed(exploration.started_at, exploration.finished_at, now)
            : '—'}
        </Meta>
        {exploration.goal && (
          <div className="col-span-full">
            <Meta label={t.goal}>{exploration.goal}</Meta>
          </div>
        )}
      </Card>
      <Tabs
        tabs={EXPLORATION_TABS.map((id) => ({ id, label: t.tabs[id] }))}
        current={tab}
        onSelect={(next) => void navigate({ search: { tab: next } })}
      />
      {tab === 'progress' && (
        <Progress exploration={exploration} current={current} active={active} now={now} />
      )}
      {tab === 'appmap' && <AppMap exploration={exploration} />}
      {tab === 'trace' && (
        <QueryState query={steps} empty={t.trace.empty}>
          {(list) => <Trace steps={list} />}
        </QueryState>
      )}
      {tab === 'findings' && <Findings findings={exploration.findings} />}
      {tab === 'testcases' && <TestCases exploration={exploration} />}
    </>
  )
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-0.5 text-slate-800">{children}</div>
    </div>
  )
}

function StopButton({ id }: { id: string }) {
  const stop = useStopExploration(id)
  return (
    <>
      <button
        type="button"
        className={buttonClass.secondary}
        disabled={stop.isPending}
        onClick={() => stop.mutate()}
      >
        {stop.isPending ? t.stopping : t.stop}
      </button>
      {stop.isError && (
        <span role="alert" className="text-sm text-red-700">
          {errorMessage(stop.error)}
        </span>
      )}
    </>
  )
}

function Stat({ label, value, testId }: { label: string; value: ReactNode; testId?: string }) {
  return (
    <Card className="p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-lg font-medium text-slate-900" data-testid={testId}>
        {value}
      </div>
    </Card>
  )
}

function Progress({
  exploration,
  current,
  active,
  now,
}: {
  exploration: api.ExplorationDetail
  current: ReturnType<typeof useWatchExploration>
  active: boolean
  now: number
}) {
  const { stats, budget } = exploration
  const minutes = exploration.started_at
    ? elapsed(exploration.started_at, exploration.finished_at, now)
    : '—'
  return (
    <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
      <div>{active && <LiveView deviceId={exploration.device_id} />}</div>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <Stat
            label={t.steps}
            value={`${stats.steps} / ${budget.max_steps}`}
            testId="exploration-steps"
          />
          <Stat
            label={t.screens}
            value={
              <>
                {stats.screens}{' '}
                <span className="text-sm text-slate-500">({t.newScreens(stats.new_screens)})</span>
              </>
            }
          />
          <Stat
            label={t.cost}
            value={costOfBudget(stats.cost_usd, budget.max_cost_usd)}
            testId="exploration-cost"
          />
          <Stat label={t.time} value={`${minutes} / ${budget.max_minutes}m`} />
          <Stat label={t.refused} value={stats.refused} />
          <Stat label={t.findings} value={stats.findings} />
        </div>
        {current && (
          <Card className="p-3 text-sm" data-testid="exploration-current">
            <span className="text-slate-500">{t.now} </span>
            <span className="font-mono">#{current.n}</span>{' '}
            {current.screen_name && <span className="font-medium">{current.screen_name}: </span>}
            {current.action_summary}
          </Card>
        )}
        {exploration.stop_reason && (
          <p className="text-sm text-slate-600" data-testid="exploration-stop-reason">
            {t.stoppedBecause} {t.stopReasons[exploration.stop_reason]}
          </p>
        )}
      </div>
    </div>
  )
}

function AppMap({ exploration }: { exploration: api.ExplorationDetail }) {
  const { screens, transitions } = exploration.appmap
  const nameOf = (id: string) => screens.find((s) => s.id === id)?.name ?? id
  return (
    <div className="space-y-6">
      {screens.length === 0 ? (
        <p className="text-sm text-slate-500">{t.noScreens}</p>
      ) : (
        <ul
          className="grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-5"
          aria-label={t.tabs.appmap}
        >
          {screens.map((screen) => (
            <li key={screen.id}>
              <Card className="overflow-hidden">
                {screen.screenshot_url && (
                  <img
                    src={screen.screenshot_url}
                    alt={screen.name}
                    className="aspect-[9/19] w-full bg-slate-100 object-cover object-top"
                  />
                )}
                <div className="space-y-1 p-2 text-sm">
                  <div className="font-medium">{screen.name}</div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs text-slate-500">{screen.id}</span>
                    <Badge tone={screen.is_new ? 'green' : 'slate'}>
                      {screen.is_new ? t.newScreen : t.knownScreen}
                    </Badge>
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <div>
        <h3 className="mb-2 text-sm font-medium">{t.transitions}</h3>
        {transitions.length === 0 ? (
          <p className="text-sm text-slate-500">{t.noTransitions}</p>
        ) : (
          <ul className="space-y-1 text-sm" aria-label={t.transitions}>
            {transitions.map((transition, i) => {
              const target = (transition.action as { target?: unknown[] }).target?.[0]
              return (
                <li key={i} className="text-slate-700">
                  {nameOf(transition.from)} → {nameOf(transition.to)}
                  <span className="ml-2 font-mono text-xs text-slate-500">
                    {transition.action.action}
                    {target ? ` ${JSON.stringify(target)}` : ''}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

function Trace({ steps }: { steps: api.ExplorationStepView[] }) {
  const [open, setOpen] = useState<number | undefined>()
  const selected = steps.find((s) => s.n === open)
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_520px]">
      <Table label={t.tabs.trace}>
        <thead>
          <tr>
            <Th className="w-10">{t.trace.n}</Th>
            <Th className="w-16">{t.trace.picture}</Th>
            <Th>{t.trace.screen}</Th>
            <Th>{t.trace.decision}</Th>
            <Th>{t.trace.status}</Th>
            <Th className="w-20">{t.trace.cost}</Th>
          </tr>
        </thead>
        <tbody>
          {steps.map((step) => (
            <tr
              key={step.n}
              className={`cursor-pointer hover:bg-slate-50 ${step.n === open ? 'bg-sky-50' : ''}`}
              onClick={() => setOpen(step.n === open ? undefined : step.n)}
            >
              <Td className="font-mono">{step.n}</Td>
              <Td>
                {step.screenshot_url && (
                  <img
                    src={step.screenshot_url}
                    alt=""
                    className="h-14 rounded border border-slate-200"
                  />
                )}
              </Td>
              <Td className="text-slate-700">{step.screen.name ?? '—'}</Td>
              <Td>
                <button type="button" className="text-left font-mono text-xs text-slate-800">
                  {describeStep(step)}
                </button>
                {!step.decision && (
                  <span className="ml-2 text-xs text-slate-400">({t.trace.system})</span>
                )}
                {step.decision && 'reason' in step.decision && (
                  <div className="max-w-md truncate text-xs text-slate-500">
                    {step.decision.reason}
                  </div>
                )}
              </Td>
              <Td>
                <Badge tone={STEP_TONES[step.status]}>
                  {step.status}
                  {step.refusal ? `: ${step.refusal}` : ''}
                </Badge>
              </Td>
              <Td className="text-slate-500">{usd(step.cost_usd)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
      {selected && <StepDetail step={selected} />}
    </div>
  )
}

function Findings({ findings }: { findings: api.Finding[] }) {
  if (findings.length === 0) return <p className="text-sm text-slate-500">{t.findingsEmpty}</p>
  return (
    <ul className="space-y-4">
      {findings.map((finding) => (
        <li key={finding.id}>
          <Card className="flex gap-4 p-4">
            {finding.screenshot_url && (
              <img
                src={finding.screenshot_url}
                alt=""
                className="h-48 rounded border border-slate-200"
              />
            )}
            <div className="min-w-0 flex-1 space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <Badge tone="red">{finding.kind}</Badge>
                <span className="text-slate-500">{t.atStep(finding.step_n)}</span>
                <span className="text-slate-400">{formatTime(finding.created_at)}</span>
              </div>
              <div className="text-xs text-slate-500">{t.log}</div>
              <pre className="max-h-64 overflow-auto rounded bg-slate-900 p-3 text-xs text-slate-100">
                {finding.log_excerpt}
              </pre>
            </div>
          </Card>
        </li>
      ))}
    </ul>
  )
}

function TestCases({ exploration }: { exploration: api.ExplorationDetail }) {
  if (exploration.test_cases.length === 0) {
    return <p className="text-sm text-slate-500">{t.testCasesEmpty}</p>
  }
  return (
    <Table label={t.tabs.testcases}>
      <thead>
        <tr>
          <Th>{en.testCases.slug}</Th>
          <Th>{en.testCases.status}</Th>
          <Th>{t.draftReason}</Th>
          <Th>{t.flags}</Th>
        </tr>
      </thead>
      <tbody>
        {exploration.test_cases.map((testCase) => (
          <tr key={testCase.id}>
            <Td className="font-mono">
              <Link
                to="/projects/$projectId/testcases/$testCaseId"
                params={{ projectId: exploration.project_id, testCaseId: testCase.id }}
                className={buttonClass.link}
              >
                {testCase.slug}
              </Link>
            </Td>
            <Td>
              <Badge tone={testCase.status === 'active' ? 'green' : 'slate'}>
                {testCase.status}
              </Badge>
            </Td>
            <Td className="text-slate-600">{testCase.draft_reason ?? '—'}</Td>
            <Td className="text-slate-600">{testCase.flags.join(', ') || '—'}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  )
}
