import type { api } from '@coral/shared'
import { useBrainCall } from '../../api/explorations'
import { Badge, Card, errorMessage } from '../../components/ui'
import { en } from '../../i18n/en'
import { describeStep, STEP_TONES, usd } from './describe'

const t = en.exploration

/**
 * One trace step opened (FR-006a): what the AI saw — the picture and the element list it was sent —
 * and what it answered, with its reason and tool rounds. After 30 days only the step remains.
 */
export function StepDetail({ step }: { step: api.ExplorationStepView }) {
  const call = useBrainCall(step.brain_call_id)
  return (
    <Card className="space-y-4 p-4 text-sm" aria-label={`step ${step.n}`}>
      <div className="flex items-center gap-2">
        <span className="font-mono">#{step.n}</span>
        <span className="font-medium">{step.screen.name ?? '—'}</span>
        <Badge tone={STEP_TONES[step.status]}>
          {step.status}
          {step.refusal ? `: ${step.refusal}` : ''}
        </Badge>
        <span className="ml-auto text-slate-500">{usd(step.cost_usd)}</span>
      </div>
      <div className="font-mono text-xs">{describeStep(step)}</div>
      {!step.brain_call_id ? (
        <p className="text-slate-500">{t.noCall}</p>
      ) : call.isPending ? (
        <p role="status" className="text-slate-500">
          {t.loadingCall}
        </p>
      ) : call.isError ? (
        <p role="alert" className="text-red-700">
          {errorMessage(call.error)}
        </p>
      ) : !call.data.content ? (
        <p className="rounded-md bg-slate-50 px-3 py-2 text-slate-600">{t.expired}</p>
      ) : (
        <AiContent call={call.data} content={call.data.content} />
      )}
    </Card>
  )
}

function AiContent({ call, content }: { call: api.BrainCall; content: api.BrainCallContent }) {
  const seen = content.messages.find((m) => m.role === 'user')
  const decision = content.decision
  const reason =
    typeof decision === 'object' && decision !== null && 'reason' in decision
      ? String(decision.reason)
      : undefined
  return (
    <>
      <section className="space-y-2">
        <h3 className="font-medium">{t.saw}</h3>
        {seen?.image && (
          <img src={seen.image} alt={t.saw} className="max-h-96 rounded border border-slate-200" />
        )}
        <pre className="max-h-72 overflow-auto rounded bg-slate-50 p-3 text-xs whitespace-pre-wrap text-slate-700">
          {seen?.text}
        </pre>
      </section>
      <section className="space-y-2">
        <h3 className="font-medium">{t.answered}</h3>
        <div className="text-xs text-slate-500">
          {call.provider} · {call.model} · {usd(call.cost_usd)}
        </div>
        {reason && (
          <p>
            <span className="text-slate-500">{t.reason}: </span>
            {reason}
          </p>
        )}
        <pre className="overflow-auto rounded bg-slate-50 p-3 text-xs text-slate-700">
          {JSON.stringify(content.decision ?? content.answer, null, 2)}
        </pre>
        {content.validation_errors.length > 0 && (
          <div>
            <div className="text-xs text-slate-500">{t.invalid}</div>
            <ul className="list-disc pl-5 text-xs text-amber-800">
              {content.validation_errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </div>
        )}
        {content.rounds.length > 0 && (
          <div>
            <div className="text-xs text-slate-500">{t.tools}</div>
            <ol className="space-y-1 text-xs">
              {content.rounds.flatMap((round, i) =>
                round.tool_calls.map((tool, j) => (
                  <li key={`${i}-${j}`} className="font-mono">
                    {tool.name}({JSON.stringify(tool.args)}) → {tool.result.slice(0, 200)}
                  </li>
                )),
              )}
            </ol>
          </div>
        )}
      </section>
    </>
  )
}
