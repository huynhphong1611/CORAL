import type { api } from '@coral/shared'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useState } from 'react'
import { useApps, useBuilds, useProjects, useRole, useTestCases } from '../../api/queries'
import { useRecordings } from '../../api/recordings'
import { PageHeader } from '../../components/Layout'
import { RunDialog } from '../../components/RunDialog'
import { RunsTable } from '../../components/RunsTable'
import {
  Badge,
  buttonClass,
  Card,
  formatTime,
  QueryState,
  Table,
  Tabs,
  Td,
  Th,
  type Tone,
} from '../../components/ui'
import { ExploreButton, ExplorationsTab } from '../../features/explorations/ExplorationsTab'
import { NewAppForm, UploadBuild } from '../../features/setup/AppForms'
import { en } from '../../i18n/en'

export const PROJECT_TABS = ['testcases', 'runs', 'recordings', 'explorations', 'apps'] as const
export type ProjectTab = (typeof PROJECT_TABS)[number]

/** `/projects/$projectId`: test cases, runs, recordings and apps of one project (FR-003). */
export function ProjectPage() {
  const { projectId } = useParams({ from: '/_app/projects/$projectId' })
  const { tab } = useSearch({ from: '/_app/projects/$projectId' })
  const navigate = useNavigate({ from: '/projects/$projectId' })
  const projects = useProjects()
  const project = projects.data?.find((p) => p.id === projectId)

  return (
    <section>
      <nav aria-label="Breadcrumb" className="mb-2 text-sm text-slate-500">
        <Link to="/projects" className="hover:text-slate-800">
          {en.projects.title}
        </Link>
      </nav>
      <QueryState
        query={{ ...projects, data: projects.data ? [project] : undefined }}
        isEmpty={([p]) => p === undefined}
        empty={en.projects.notFound}
      >
        {() => (
          <>
            <PageHeader title={project?.name ?? ''}>
              <div className="flex items-center gap-2">
                <ExploreButton projectId={projectId} />
                <RecordButton projectId={projectId} />
              </div>
            </PageHeader>
            <Tabs
              tabs={PROJECT_TABS.map((id) => ({ id, label: en.projects.tabs[id] }))}
              current={tab}
              onSelect={(next) => void navigate({ search: { tab: next } })}
            />
            {tab === 'testcases' && <TestCasesTab projectId={projectId} />}
            {tab === 'runs' && <RunsTable filters={{ project_id: projectId }} />}
            {tab === 'recordings' && <RecordingsTab projectId={projectId} />}
            {tab === 'explorations' && <ExplorationsTab projectId={projectId} />}
            {tab === 'apps' && <AppsTab projectId={projectId} />}
          </>
        )}
      </QueryState>
    </section>
  )
}

const SOURCE_TONES: Record<api.TestCaseSource, Tone> = {
  recorder: 'violet',
  manual: 'slate',
  ai_explore: 'blue',
  ai_prompt: 'blue',
  ai_import: 'blue',
}
const STATUS_TONES = { active: 'green', draft: 'slate', quarantined: 'amber' } as const

/** Test cases with Run on each row and on a selection (FR-004); writers only. */
function TestCasesTab({ projectId }: { projectId: string }) {
  const testCases = useTestCases(projectId)
  const { canWrite } = useRole()
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [running, setRunning] = useState<readonly string[] | undefined>()

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <QueryState query={testCases} empty={en.testCases.empty}>
      {(list) => (
        <div className="space-y-3">
          {canWrite && (
            <div className="flex justify-end">
              <button
                type="button"
                className={buttonClass.primary}
                disabled={selected.size === 0}
                onClick={() => setRunning([...selected])}
              >
                {en.testCases.runSelected(selected.size)}
              </button>
            </div>
          )}
          <Table label={en.projects.tabs.testcases}>
            <thead>
              <tr>
                {canWrite && (
                  <Th className="w-10">
                    <input
                      type="checkbox"
                      aria-label={en.testCases.selectAll}
                      checked={selected.size === list.length}
                      onChange={(e) =>
                        setSelected(new Set(e.target.checked ? list.map((t) => t.id) : []))
                      }
                    />
                  </Th>
                )}
                <Th>{en.testCases.slug}</Th>
                <Th>{en.testCases.intent}</Th>
                <Th>{en.testCases.status}</Th>
                <Th>{en.testCases.source}</Th>
                <Th>{en.testCases.updated}</Th>
                {canWrite && <Th className="w-20" />}
              </tr>
            </thead>
            <tbody>
              {list.map((testCase) => (
                <TestCaseRow
                  key={testCase.id}
                  projectId={projectId}
                  testCase={testCase}
                  canWrite={canWrite}
                  selected={selected.has(testCase.id)}
                  onToggle={() => toggle(testCase.id)}
                  onRun={() => setRunning([testCase.id])}
                />
              ))}
            </tbody>
          </Table>
          {running && (
            <RunDialog
              projectId={projectId}
              testCaseIds={running}
              onClose={() => setRunning(undefined)}
            />
          )}
        </div>
      )}
    </QueryState>
  )
}

function TestCaseRow({
  projectId,
  testCase,
  canWrite,
  selected,
  onToggle,
  onRun,
}: {
  projectId: string
  testCase: api.TestCaseSummary
  canWrite: boolean
  selected: boolean
  onToggle: () => void
  onRun: () => void
}) {
  return (
    <tr className="hover:bg-slate-50">
      {canWrite && (
        <Td>
          <input
            type="checkbox"
            aria-label={en.testCases.select(testCase.slug)}
            checked={selected}
            onChange={onToggle}
          />
        </Td>
      )}
      <Td className="font-mono">
        <Link
          to="/projects/$projectId/testcases/$testCaseId"
          params={{ projectId, testCaseId: testCase.id }}
          className="text-slate-900 underline-offset-2 hover:underline"
        >
          {testCase.slug}
        </Link>
      </Td>
      <Td className="max-w-sm text-slate-700">{testCase.intent}</Td>
      <Td>
        <Badge tone={STATUS_TONES[testCase.status]}>{testCase.status}</Badge>
      </Td>
      <Td>
        <Badge tone={SOURCE_TONES[testCase.source]}>{testCase.source}</Badge>
      </Td>
      <Td className="text-slate-500">{formatTime(testCase.updated_at)}</Td>
      {canWrite && (
        <Td>
          <button
            type="button"
            className={buttonClass.secondary}
            aria-label={`${en.testCases.run} ${testCase.slug}`}
            onClick={onRun}
          >
            {en.testCases.run}
          </button>
        </Td>
      )}
    </tr>
  )
}

/** Starts the Recorder on this project (writers only). */
function RecordButton({ projectId }: { projectId: string }) {
  const { canWrite } = useRole()
  if (!canWrite) return null
  return (
    <Link
      to="/projects/$projectId/record"
      params={{ projectId }}
      search={{}}
      className={buttonClass.primary}
    >
      {en.recordings.record}
    </Link>
  )
}

const RECORDING_TONES = {
  recording: 'red',
  stopped: 'amber',
  saved: 'green',
  discarded: 'slate',
  expired: 'slate',
} as const

/** Recordings of the project, newest first; unfinished ones open back in the Recorder. */
function RecordingsTab({ projectId }: { projectId: string }) {
  const recordings = useRecordings(projectId)
  return (
    <QueryState query={recordings} empty={en.recordings.empty}>
      {(list) => (
        <Table label={en.projects.tabs.recordings}>
          <thead>
            <tr>
              <Th>{en.recordings.slug}</Th>
              <Th>{en.testCases.intent}</Th>
              <Th>{en.recordings.status}</Th>
              <Th>{en.recordings.by}</Th>
              <Th>{en.recordings.updated}</Th>
              <Th className="w-20" />
            </tr>
          </thead>
          <tbody>
            {list.map((recording) => (
              <tr key={recording.id} className="hover:bg-slate-50">
                <Td className="font-mono text-slate-900">{recording.slug}</Td>
                <Td className="max-w-sm text-slate-700">{recording.intent}</Td>
                <Td>
                  <Badge tone={RECORDING_TONES[recording.status]}>{recording.status}</Badge>
                </Td>
                <Td className="text-slate-600">{recording.created_by.name}</Td>
                <Td className="text-slate-500">{formatTime(recording.updated_at)}</Td>
                <Td>
                  <Link
                    to="/recordings/$recordingId"
                    params={{ recordingId: recording.id }}
                    className={buttonClass.link}
                  >
                    {en.recordings.open}
                  </Link>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </QueryState>
  )
}

/** Apps and their builds; writers add apps and upload APKs (US7). */
function AppsTab({ projectId }: { projectId: string }) {
  const apps = useApps(projectId)
  const { canWrite } = useRole()
  return (
    <div className="space-y-4">
      {canWrite && (
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-medium">{en.apps.newApp}</h3>
          <NewAppForm projectId={projectId} />
        </Card>
      )}
      <QueryState query={apps} empty={en.apps.empty}>
        {(list) => (
          <div className="space-y-4">
            {list.map((app) => (
              <Card key={app.id} className="space-y-3 p-4">
                <div className="flex items-baseline gap-3">
                  <h3 className="font-medium">{app.name}</h3>
                  <span className="font-mono text-xs text-slate-500">
                    {app.package_or_bundle_id}
                  </span>
                </div>
                <Builds appId={app.id} />
                {canWrite && <UploadBuild app={app} />}
              </Card>
            ))}
          </div>
        )}
      </QueryState>
    </div>
  )
}

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

function Builds({ appId }: { appId: string }) {
  const builds = useBuilds(appId)
  return (
    <QueryState query={builds} empty={en.apps.noBuilds}>
      {(list) => (
        <table aria-label={en.apps.builds} className="w-full text-left text-sm">
          <thead>
            <tr className="text-xs text-slate-500 uppercase">
              <th className="py-1 font-medium">{en.apps.version}</th>
              <th className="py-1 font-medium">{en.apps.size}</th>
              <th className="py-1 font-medium">{en.apps.uploaded}</th>
            </tr>
          </thead>
          <tbody>
            {list.map((build) => (
              <tr key={build.id} className="border-t border-slate-100">
                <td className="py-1.5 font-mono">{build.version}</td>
                <td className="py-1.5 text-slate-600">{megabytes(build.size_bytes)}</td>
                <td className="py-1.5 text-slate-500">{formatTime(build.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </QueryState>
  )
}
