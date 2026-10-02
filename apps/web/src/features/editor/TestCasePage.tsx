import { api, type Step } from '@coral/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { ApiError } from '../../api/client'
import { keys, useCoral, useProjects, useRole } from '../../api/queries'
import { testCaseKeys, useTestCase } from '../../api/testcases'
import { PageHeader } from '../../components/Layout'
import { RunDialog } from '../../components/RunDialog'
import { Badge, buttonClass, Card, errorMessage, QueryState } from '../../components/ui'
import { YamlEditor, type EditorIssue, type YamlEditorHandle } from '../../components/YamlEditor'
import { en } from '../../i18n/en'
import { CHECK_MS, checkTestCase, useDebounced, type Problem } from './check'
import { HistoryPanel } from './HistoryPanel'
import { StatusPanel } from './StatusPanel'
import { StepPictures } from './StepPictures'

const savedSchema = z.object({
  head_commit: api.commitSha,
  warnings: api.validationIssueSchema.array(),
})

const NONE: readonly Problem[] = []
const NO_ISSUES: readonly EditorIssue[] = []
const toIssue =
  (severity: EditorIssue['severity']) =>
  (problem: Problem): EditorIssue => ({
    severity,
    message: `${problem.code}: ${problem.message}`,
    line: problem.line,
    column: problem.column,
  })

/**
 * `/projects/$projectId/testcases/$testCaseId` — the test case editor (US5, contracts/web-ui.md):
 * YAML checked as you type (FR-018), a picture beside each step (FR-019), Save as one commit that
 * refuses to overwrite someone else's (409), and History (FR-020).
 */
export function TestCasePage() {
  const { projectId, testCaseId } = useParams({
    from: '/_app/projects/$projectId/testcases/$testCaseId',
  })
  const testCase = useTestCase(testCaseId)
  return (
    <QueryState query={testCase}>
      {(loaded) => <Editor key={loaded.id} projectId={projectId} testCase={loaded} />}
    </QueryState>
  )
}

function Editor({ projectId, testCase }: { projectId: string; testCase: api.TestCaseDetail }) {
  const { client } = useCoral()
  const queryClient = useQueryClient()
  const { canWrite } = useRole()
  const project = useProjects().data?.find((p) => p.id === projectId)
  // What the server has (the base of the next save) and what is being edited.
  const [base, setBase] = useState({ commit: testCase.head_commit, yaml: testCase.yaml })
  const [text, setText] = useState(testCase.yaml)
  const [serverProblems, setServerProblems] = useState<{ text: string; problems: Problem[] }>()
  const [conflict, setConflict] = useState(false)
  const [notice, setNotice] = useState<string | undefined>()
  const [showHistory, setShowHistory] = useState(false)
  const [running, setRunning] = useState(false)
  const editor = useRef<YamlEditorHandle>(null)

  const settled = useDebounced(text, CHECK_MS)
  const checked = useMemo(() => checkTestCase(settled, testCase.slug), [settled, testCase.slug])
  const checking = settled !== text
  // Problems the server found (an image not in the repo) hold until the text changes.
  const fromServer = serverProblems?.text === text ? serverProblems.problems : NONE
  const errors = useMemo(() => [...checked.errors, ...fromServer], [checked.errors, fromServer])
  const issues = useMemo(
    () =>
      checking
        ? NO_ISSUES
        : [...errors.map(toIssue('error')), ...checked.warnings.map(toIssue('warning'))],
    [checking, errors, checked.warnings],
  )
  const dirty = text !== base.yaml

  // The pictures follow the last text that parsed, so they do not flicker while typing.
  const [steps, setSteps] = useState<readonly Step[]>(
    () => checkTestCase(testCase.yaml, testCase.slug).testCase?.steps ?? [],
  )
  useEffect(() => {
    if (checked.testCase) setSteps(checked.testCase.steps)
  }, [checked.testCase])

  useEffect(() => {
    if (!dirty) return undefined
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const save = useMutation({
    mutationFn: (yaml: string) =>
      client.put(`/testcases/${testCase.id}`, { yaml, base_commit: base.commit }, savedSchema),
    onMutate: () => setNotice(undefined),
    onSuccess: (saved, yaml) => {
      setBase({ commit: saved.head_commit, yaml })
      setConflict(false)
      setNotice(en.editor.saved)
      queryClient.setQueryData<api.TestCaseDetail>(testCaseKeys.one(testCase.id), (current) =>
        current ? { ...current, yaml, head_commit: saved.head_commit } : current,
      )
      void queryClient.invalidateQueries({ queryKey: testCaseKeys.history(testCase.id) })
      void queryClient.invalidateQueries({ queryKey: keys.testCases(projectId) })
    },
    onError: (error, yaml) => {
      if (error instanceof ApiError && error.status === 409) {
        setConflict(true)
        return
      }
      if (error instanceof ApiError && Array.isArray(error.details) && error.details.length > 0) {
        setServerProblems({ text: yaml, problems: error.details })
        return
      }
      setNotice(errorMessage(error))
    },
  })

  const loadLatest = useMutation({
    mutationFn: () => client.get(`/testcases/${testCase.id}`, api.testCaseDetailSchema),
    onSuccess: (latest) => {
      queryClient.setQueryData(testCaseKeys.one(testCase.id), latest)
      setBase({ commit: latest.head_commit, yaml: latest.yaml })
      setText(latest.yaml)
      setConflict(false)
      setNotice(undefined)
      void queryClient.invalidateQueries({ queryKey: testCaseKeys.history(testCase.id) })
    },
    onError: (error) => setNotice(errorMessage(error)),
  })

  const canSave = canWrite && dirty && !checking && errors.length === 0 && !save.isPending

  return (
    <section>
      <nav aria-label="Breadcrumb" className="mb-2 text-sm text-slate-500">
        <Link
          to="/projects/$projectId"
          params={{ projectId }}
          search={{ tab: 'testcases' }}
          className="hover:text-slate-800"
        >
          {project?.name ?? en.editor.back}
        </Link>
      </nav>
      <PageHeader title={testCase.slug}>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={buttonClass.secondary}
            aria-expanded={showHistory}
            onClick={() => setShowHistory((open) => !open)}
          >
            {showHistory ? en.editor.hideHistory : en.editor.history}
          </button>
          {canWrite && (
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => setRunning(true)}
            >
              {en.testCases.run}
            </button>
          )}
          {canWrite && (
            <button
              type="button"
              className={buttonClass.primary}
              disabled={!canSave}
              onClick={() => save.mutate(text)}
            >
              {save.isPending ? en.editor.saving : en.editor.save}
            </button>
          )}
        </div>
      </PageHeader>
      <StatusPanel projectId={projectId} testCase={testCase} />

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1 space-y-3 lg:sticky lg:top-4">
          {conflict && (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900"
            >
              <span>{en.editor.conflict}</span>
              <button
                type="button"
                className={buttonClass.secondary}
                disabled={loadLatest.isPending}
                onClick={() => window.confirm(en.editor.confirmLoadLatest) && loadLatest.mutate()}
              >
                {en.editor.loadLatest}
              </button>
            </div>
          )}
          {!canWrite && <p className="text-sm text-slate-500">{en.editor.readOnly}</p>}
          <YamlEditor
            ref={editor}
            value={text}
            onChange={(next) => {
              setText(next)
              setNotice(undefined)
            }}
            issues={issues}
            readOnly={!canWrite}
            label={en.editor.label}
          />
          <Status
            checking={checking}
            dirty={dirty}
            errors={errors}
            warnings={checked.warnings}
            notice={notice}
            onReveal={(problem) => editor.current?.reveal(problem)}
          />
          {showHistory && (
            <Card className="p-4">
              <h2 className="mb-2 text-sm font-medium">{en.editor.history}</h2>
              <HistoryPanel testCaseId={testCase.id} head={base.commit} />
            </Card>
          )}
        </div>
        <Card className="w-full p-4 lg:w-80">
          <h2 className="mb-3 text-sm font-medium">{en.editor.pictures}</h2>
          <StepPictures testCaseId={testCase.id} commit={base.commit} steps={steps} />
        </Card>
      </div>
      {running && (
        <RunDialog
          projectId={projectId}
          testCaseIds={[testCase.id]}
          onClose={() => setRunning(false)}
        />
      )}
    </section>
  )
}

/** Below the editor: checking / valid / the problems with their place, and save outcomes. */
function Status({
  checking,
  dirty,
  errors,
  warnings,
  notice,
  onReveal,
}: {
  checking: boolean
  dirty: boolean
  errors: readonly Problem[]
  warnings: readonly Problem[]
  notice: string | undefined
  onReveal: (problem: Problem) => void
}) {
  return (
    <div className="space-y-2 text-sm" data-testid="editor-status">
      <p className="flex flex-wrap items-center gap-2 text-xs">
        {checking ? (
          <span className="text-slate-500">{en.editor.checking}</span>
        ) : errors.length > 0 ? (
          <span className="font-medium text-red-700">{en.editor.problems(errors.length)}</span>
        ) : (
          <span className="text-emerald-700">{en.editor.valid}</span>
        )}
        {dirty && <Badge tone="amber">{en.editor.unsaved}</Badge>}
      </p>
      {!checking && errors.length > 0 && (
        <ProblemList problems={errors} tone="error" onReveal={onReveal} />
      )}
      {!checking && warnings.length > 0 && (
        <ProblemList problems={warnings} tone="warning" onReveal={onReveal} />
      )}
      {notice && (
        <p role="status" className="rounded-md bg-slate-100 px-3 py-2 text-slate-700">
          {notice}
        </p>
      )}
    </div>
  )
}

/** Problems with their place; one with a line takes the cursor there. */
function ProblemList({
  problems,
  tone,
  onReveal,
}: {
  problems: readonly Problem[]
  tone: 'error' | 'warning'
  onReveal: (problem: Problem) => void
}) {
  return (
    <div role={tone === 'error' ? 'alert' : undefined}>
      <ul
        aria-label={tone === 'error' ? 'Errors' : 'Warnings'}
        className={`space-y-0.5 text-xs ${tone === 'error' ? 'text-red-700' : 'text-amber-800'}`}
      >
        {problems.map((p) => (
          <li key={`${p.path}-${p.code}-${p.line ?? ''}`}>
            {p.line !== undefined && (
              <button
                type="button"
                className="font-mono underline-offset-2 hover:underline"
                title={en.editor.goTo}
                onClick={() => onReveal(p)}
              >
                {en.editor.issueAt(p.line, p.column ?? 1)}
              </button>
            )}
            {p.line !== undefined && ' · '}
            {p.step_id && <span className="font-mono">{p.step_id} · </span>}
            {p.code}: {p.message}
          </li>
        ))}
      </ul>
    </div>
  )
}
