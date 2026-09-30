import type { api, Step } from '@coral/shared'
import { useState } from 'react'
import { useApiFile, useLastRunSteps, useSnapshots } from '../../api/testcases'
import { formatTime, shortId } from '../../components/ui'
import { en } from '../../i18n/en'
import { stepSummary } from '../recorder/describe'

type Snapshot = api.TestCaseSnapshots[number]
type RunPicture = api.LastRunSteps[number]

/**
 * A picture beside each step (FR-019): the Recorder's snapshot of the screen before it, else the
 * step's screenshot from the latest run, else "No image yet".
 */
export function StepPictures({
  testCaseId,
  commit,
  steps,
}: {
  testCaseId: string
  commit: string
  steps: readonly Step[]
}) {
  const snapshots = useSnapshots(testCaseId, commit)
  const lastRun = useLastRunSteps(testCaseId)
  const snapshotOf = new Map((snapshots.data ?? []).map((s) => [s.step_id, s]))
  const runPictureOf = new Map((lastRun.data ?? []).map((s) => [s.step_id, s]))
  const loading = snapshots.isPending || lastRun.isPending

  return (
    <ol className="space-y-3" aria-label={en.editor.pictures}>
      {steps.map((step) => (
        <li key={step.id} data-testid={`picture-${step.id}`} className="flex gap-3 text-sm">
          <div className="w-24 shrink-0">
            <Picture
              stepId={step.id}
              loading={loading}
              snapshot={snapshotOf.get(step.id)}
              runPicture={runPictureOf.get(step.id)}
            />
          </div>
          <div className="min-w-0 pt-1">
            <p className="font-mono text-xs text-slate-500">{step.id}</p>
            <p className="break-words text-slate-800">{stepSummary(step)}</p>
          </div>
        </li>
      ))}
    </ol>
  )
}

function Picture({
  stepId,
  loading,
  snapshot,
  runPicture,
}: {
  stepId: string
  loading: boolean
  snapshot: Snapshot | undefined
  runPicture: RunPicture | undefined
}) {
  if (snapshot) return <SnapshotImage stepId={stepId} path={snapshot.screen_url} />
  if (runPicture) {
    return (
      <Figure
        caption={en.editor.fromRun(shortId(runPicture.run_id), formatTime(runPicture.finished_at))}
      >
        <RemoteImage stepId={stepId} src={runPicture.screenshot_url} />
      </Figure>
    )
  }
  return <Placeholder text={loading ? en.common.loading : en.editor.noImage} />
}

/** A snapshot in the project repo: fetched with the access token. */
function SnapshotImage({ stepId, path }: { stepId: string; path: string }) {
  const url = useApiFile(path)
  if (url === undefined) return <Placeholder text={en.common.loading} />
  return (
    <Figure caption={en.editor.recorded}>
      {url === null ? (
        <Placeholder text={en.recorder.imageUnavailable} />
      ) : (
        <RemoteImage stepId={stepId} src={url} />
      )}
    </Figure>
  )
}

function RemoteImage({ stepId, src }: { stepId: string; src: string }) {
  const [broken, setBroken] = useState(false)
  if (broken) return <Placeholder text={en.recorder.imageUnavailable} />
  return (
    <img
      src={src}
      alt={en.editor.pictureOf(stepId)}
      onError={() => setBroken(true)}
      className="aspect-[9/20] w-full rounded bg-slate-100 object-cover object-top"
    />
  )
}

function Figure({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <figure className="space-y-1">
      {children}
      <figcaption className="text-[10px] leading-tight text-slate-500">{caption}</figcaption>
    </figure>
  )
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="flex aspect-[9/20] w-full items-center justify-center rounded bg-slate-100 p-1 text-center text-[10px] text-slate-500">
      {text}
    </div>
  )
}
