import type { ExpectCondition } from '@coral/shared'
import { useState } from 'react'
import type { RecordingStepView } from '../../api/recordings'
import { Badge } from '../../components/ui'
import { en } from '../../i18n/en'
import { conditionLabel, stepSummary } from './describe'

/**
 * The recorded steps (FR-013, FR-013a, FR-016): a thumbnail of the screen before each one, what it
 * does, its expectations, warnings, and the suggested expectations as chips to accept. The author
 * deletes and reorders steps (buttons, or drag and drop). Problems from a failed save show on
 * their step.
 */
export function StepList({
  steps,
  errors,
  canEdit,
  onAccept,
  onDelete,
  onMove,
}: {
  steps: readonly RecordingStepView[]
  /** Save problems by step id. */
  errors: ReadonlyMap<string, readonly string[]>
  canEdit: boolean
  onAccept: (n: number, condition: ExpectCondition) => void
  onDelete: (n: number) => void
  onMove: (n: number, to: number) => void
}) {
  const [dragged, setDragged] = useState<number | undefined>()
  if (steps.length === 0) return <p className="text-sm text-slate-500">{en.recorder.noSteps}</p>

  return (
    <ol className="space-y-2" aria-label={en.recorder.steps}>
      {steps.map((recorded, index) => {
        const { step } = recorded
        const problems = errors.get(step.id) ?? []
        const fixed = step.action === 'launch'
        return (
          <li
            key={recorded.n}
            data-testid={`step-${step.id}`}
            draggable={canEdit && !fixed}
            onDragStart={() => setDragged(recorded.n)}
            onDragOver={(e) => canEdit && dragged !== undefined && index > 0 && e.preventDefault()}
            onDrop={() => {
              if (dragged !== undefined && dragged !== recorded.n) onMove(dragged, index)
              setDragged(undefined)
            }}
            className={`flex gap-3 rounded-lg border bg-white p-2 text-sm ${
              problems.length > 0 ? 'border-red-400 ring-1 ring-red-200' : 'border-slate-200'
            }`}
          >
            <Thumbnail src={recorded.urls.screen} alt={`Screen before ${step.id}`} />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 break-words">
                  <span className="mr-1.5 font-mono text-xs text-slate-500">{step.id}</span>
                  <span className="text-slate-900">{stepSummary(step)}</span>
                </p>
                {canEdit && !fixed && (
                  <div className="flex shrink-0 gap-1 text-slate-500">
                    <IconButton
                      label={en.recorder.moveUp(step.id)}
                      disabled={index <= 1}
                      onClick={() => onMove(recorded.n, index - 1)}
                    >
                      ↑
                    </IconButton>
                    <IconButton
                      label={en.recorder.moveDown(step.id)}
                      disabled={index === steps.length - 1}
                      onClick={() => onMove(recorded.n, index + 1)}
                    >
                      ↓
                    </IconButton>
                    <IconButton
                      label={en.recorder.delete(step.id)}
                      onClick={() => onDelete(recorded.n)}
                    >
                      ×
                    </IconButton>
                  </div>
                )}
              </div>
              {(step.expect ?? []).length > 0 && (
                <p className="text-xs text-emerald-800">
                  {en.recorder.expects}: {(step.expect ?? []).map(conditionLabel).join(' · ')}
                </p>
              )}
              {recorded.warnings.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {recorded.warnings.map((w) => (
                    <Badge key={w} tone="amber">
                      {en.recorder.warnings[w]}
                    </Badge>
                  ))}
                </div>
              )}
              {canEdit && recorded.suggestions.length > 0 && (
                <div
                  className="flex flex-wrap items-center gap-1"
                  aria-label={en.recorder.suggestions}
                >
                  {recorded.suggestions.map((condition) => {
                    const label = conditionLabel(condition)
                    return (
                      <button
                        key={label}
                        type="button"
                        aria-label={`Add expectation ${label} to ${step.id}`}
                        onClick={() => onAccept(recorded.n, condition)}
                        className="rounded-full border border-dashed border-emerald-500 px-2 py-0.5 text-xs text-emerald-800 hover:bg-emerald-50"
                      >
                        + {label}
                      </button>
                    )
                  })}
                </div>
              )}
              {problems.length > 0 && (
                <ul className="space-y-0.5 text-xs text-red-700" role="alert">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function Thumbnail({ src, alt }: { src: string; alt: string }) {
  const [broken, setBroken] = useState(false)
  return broken ? (
    <div className="flex h-24 w-12 shrink-0 items-center justify-center rounded bg-slate-100 text-center text-[10px] text-slate-500">
      {en.recorder.imageUnavailable}
    </div>
  ) : (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setBroken(true)}
      className="h-24 w-12 shrink-0 rounded bg-slate-100 object-cover object-top"
    />
  )
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded px-1.5 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-30"
    >
      {children}
    </button>
  )
}
