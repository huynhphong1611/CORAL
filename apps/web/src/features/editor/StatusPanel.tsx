import { api } from '@coral/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { explorationKeys } from '../../api/explorations'
import { keys, useCoral, useRole } from '../../api/queries'
import { testCaseKeys } from '../../api/testcases'
import {
  Badge,
  buttonClass,
  Card,
  errorMessage,
  shortId,
  StatusBadge,
  type Tone,
} from '../../components/ui'
import { en } from '../../i18n/en'

const t = en.generated

export const TEST_CASE_TONES: Record<api.TestCaseStatus, Tone> = {
  active: 'green',
  draft: 'slate',
  quarantined: 'amber',
}
export const SOURCE_TONES: Record<api.TestCaseSource, Tone> = {
  recorder: 'violet',
  manual: 'slate',
  ai_explore: 'blue',
  ai_prompt: 'blue',
  ai_import: 'blue',
}

/** The exploration an AI-written test case came from (`exploration:<id>`), if any. */
export const explorationOf = (sourceRef: string | null): string | undefined =>
  sourceRef?.startsWith('exploration:') ? sourceRef.slice('exploration:'.length) : undefined

/** How one validation run ended, in a few words. */
export function describeRun(run: api.TestCaseValidation['runs'][number]): string {
  if (run.status !== 'failed') return run.status
  return [run.status, run.step_id && t.atStep(run.step_id), run.failure_code]
    .filter(Boolean)
    .join(' · ')
}

/**
 * Above the editor (US3, FR-032): where the test case came from, its status and why it is a
 * draft, its flags and validation runs, and Activate / Quarantine. A test case flagged because it
 * taps a never_tap element is activated by an owner or admin only (SPEC §9.4).
 */
export function StatusPanel({
  projectId,
  testCase,
}: {
  projectId: string
  testCase: api.TestCaseSummary
}) {
  const { client } = useCoral()
  const queryClient = useQueryClient()
  const { role, canWrite } = useRole()
  const exploration = explorationOf(testCase.source_ref)
  const flagged = testCase.flags.includes('needs_review_never_tap')
  const isAdmin = role === 'owner' || role === 'admin'

  const change = useMutation({
    mutationFn: (status: api.TestCaseStatus) =>
      client.patch(`/testcases/${testCase.id}`, { status }, api.testCaseSummarySchema),
    onSuccess: (summary) => {
      queryClient.setQueryData<api.TestCaseDetail>(testCaseKeys.one(testCase.id), (current) =>
        current ? { ...current, ...summary } : current,
      )
      void queryClient.invalidateQueries({ queryKey: keys.testCases(projectId) })
      if (exploration) {
        void queryClient.invalidateQueries({ queryKey: explorationKeys.one(exploration) })
      }
    },
  })

  return (
    <Card className="mb-4 space-y-3 p-4 text-sm" data-testid="testcase-status">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <span className="flex items-center gap-2">
          <span className="text-slate-500">{t.status}</span>
          <Badge tone={TEST_CASE_TONES[testCase.status]}>{testCase.status}</Badge>
        </span>
        <span className="flex items-center gap-2">
          <span className="text-slate-500">{t.source}</span>
          <Badge tone={SOURCE_TONES[testCase.source]}>{t.sources[testCase.source]}</Badge>
          {exploration && (
            <Link
              to="/explorations/$explorationId"
              params={{ explorationId: exploration }}
              search={{ tab: 'testcases' }}
              className={buttonClass.link}
            >
              {t.fromExploration(shortId(exploration))}
            </Link>
          )}
        </span>
        {canWrite && (
          <span className="ml-auto flex items-center gap-2">
            {testCase.status !== 'active' && (
              <button
                type="button"
                className={buttonClass.secondary}
                disabled={change.isPending || (flagged && !isAdmin)}
                title={flagged && !isAdmin ? t.adminOnly : undefined}
                onClick={() => change.mutate('active')}
              >
                {t.activate}
              </button>
            )}
            {testCase.status !== 'quarantined' && (
              <button
                type="button"
                className={buttonClass.secondary}
                disabled={change.isPending}
                onClick={() => change.mutate('quarantined')}
              >
                {t.quarantine}
              </button>
            )}
          </span>
        )}
      </div>
      {testCase.status === 'draft' && testCase.draft_reason && (
        <p className="rounded-md bg-slate-100 px-3 py-2 text-slate-700" data-testid="draft-reason">
          <span className="font-medium">{t.draftReason}</span>{' '}
          {t.draftReasons[testCase.draft_reason]}
        </p>
      )}
      {flagged && (
        <p role="note" className="rounded-md bg-amber-50 px-3 py-2 text-amber-900">
          {t.flags.needs_review_never_tap}
          {canWrite && !isAdmin && ` ${t.adminOnly}`}
        </p>
      )}
      {testCase.validation && testCase.validation.runs.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" data-testid="validation-runs">
          <span className="text-slate-500">{t.validation}</span>
          {testCase.validation.runs.map((run, i) => (
            <Link
              key={run.run_id}
              to="/runs/$runId"
              params={{ runId: run.run_id }}
              className="inline-flex items-center gap-1.5 hover:underline"
            >
              <span className="text-slate-500">{t.run(i + 1)}</span>
              {run.status === 'failed' ? (
                <Badge tone="red">{describeRun(run)}</Badge>
              ) : (
                <StatusBadge status={run.status} />
              )}
            </Link>
          ))}
        </div>
      )}
      {change.isError && (
        <p role="alert" className="text-red-700">
          {errorMessage(change.error)}
        </p>
      )}
    </Card>
  )
}
