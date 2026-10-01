import { testPlanSchema, type TestPlan } from '@coral/shared'
import type { ProjectKnowledge, WriteTestInput } from '../brain'
import { quote, stableSystem, type Prompt } from './common'

export const WRITER_ROLE = `You turn the trace of an exploration into test cases a script will replay without AI.
Each flow is a part of one segment (a fresh start of the app) from its first step to end_step.
Give each flow a slug (lowercase, digits, dashes), a short name, the intent in one sentence, and
expectations: text that must be visible after a step, or the number of a candidate listed for
that step. Never write locators. Keep only flows that test something a user cares about.`

/** `writeTest`: the trace with expectation candidates, and a manual case to follow (import). */
export function writeTestPrompt(
  input: WriteTestInput,
  knowledge: ProjectKnowledge,
): Prompt<TestPlan> {
  const lines = input.steps.map((s) => {
    const candidates = s.candidates.map((c, i) => `    candidate ${i}: ${c}`).join('\n')
    const after =
      s.textsAfter.length > 0 ? `\n    text after: ${s.textsAfter.map(quote).join(', ')}` : ''
    return `${s.n}. [segment ${s.segment}] on ${quote(s.screen)}: ${s.action} (${s.status})${after}${
      candidates ? `\n${candidates}` : ''
    }`
  })
  const manual = input.manualCase
    ? `Manual test case to turn into one flow: ${quote(input.manualCase.title)}\n${[
        ...input.manualCase.preconditions.map((p) => `Precondition: ${p}`),
        ...input.manualCase.steps.map(
          (s, i) => `Step ${i + 1}: ${s.action}${s.expected ? ` → expected: ${s.expected}` : ''}`,
        ),
      ].join(
        '\n',
      )}\nAnswer outcome "written" with one flow, or needs_human / ambiguous / app_mismatch with evidence_step and an explanation.`
    : ''
  const volatile = [
    `Write at most ${input.maxTests} flow(s).`,
    input.goal ? `Goal of the exploration: ${input.goal}` : '',
    manual,
  ]
    .filter(Boolean)
    .join('\n')
  return {
    system: { stable: stableSystem(WRITER_ROLE, knowledge), volatile },
    messages: [{ role: 'user', text: `Trace:\n${lines.join('\n')}` }],
    schema: testPlanSchema,
    task: { kind: 'write_test', input },
  }
}
