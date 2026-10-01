import type { api } from '@coral/shared'
import type { Tone } from '../../components/ui'

type Decision = NonNullable<api.ExplorationStepView['decision']>

/** `tap #4`, `type secret TEST_PASSWORD into #2`: what the AI decided, in a few words. */
export function describeDecision(decision: Decision): string {
  switch (decision.action) {
    case 'tap':
    case 'long_press':
      return `${decision.action.replace('_', ' ')} #${decision.element}`
    case 'type': {
      const value =
        decision.secret !== undefined
          ? `secret ${decision.secret}`
          : decision.test_data !== undefined
            ? `test_data ${decision.test_data}`
            : JSON.stringify(decision.text ?? '')
      return `type ${value} into #${decision.element}`
    }
    case 'swipe':
      return `swipe ${decision.direction} #${decision.element}`
    case 'tap_point':
      return `tap at ${decision.point_pct.map((v) => `${Math.round(v * 100)}%`).join(', ')}`
    case 'done':
      return decision.goal_reached ? 'goal reached' : 'goal not reachable'
    default:
      return decision.action.replace('_', ' ')
  }
}

/** What a step without an AI decision did (a system Back, a restart, a crash). */
export function describeStep(step: api.ExplorationStepView): string {
  if (step.decision) return describeDecision(step.decision)
  if (step.status === 'restart') return 'restart the app'
  return step.step?.action.replace('_', ' ') ?? '—'
}

export const EXPLORATION_TONES: Record<api.ExplorationStatus, Tone> = {
  queued: 'slate',
  running: 'blue',
  writing: 'blue',
  validating: 'blue',
  done: 'green',
  stopped: 'amber',
  failed: 'red',
  interrupted: 'amber',
}

export const STEP_TONES: Record<api.ExplorationStepStatus, Tone> = {
  done: 'green',
  refused: 'amber',
  failed: 'red',
  popup: 'violet',
  restart: 'slate',
}

export const usd = (value: number) => `$${value.toFixed(2)}`

/** Cost always shown with its limit (`$0.82 / $3.00`). */
export const costOfBudget = (spent: number, limit: number) => `${usd(spent)} / ${usd(limit)}`
