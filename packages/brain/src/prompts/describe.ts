import { screenSummarySchema, type ScreenSummary } from '@coral/shared'
import type { ProjectKnowledge, ScreenInput } from '../brain'
import { screenText, stableSystem, userMessage, type Prompt } from './common'

export const DESCRIBE_ROLE = `You name screens of a mobile app for a test map.
Answer with a short name (at most 60 characters) a tester would use, in the language of the
project rules (Vietnamese when they do not say), and one sentence on what the screen is for.`

/** `describeScreen`: the name of a new screen in the app map (contracts/appmap.md). */
export function describePrompt(
  input: ScreenInput,
  knowledge: ProjectKnowledge,
): Prompt<ScreenSummary> {
  return {
    system: { stable: stableSystem(DESCRIBE_ROLE, knowledge), volatile: '' },
    messages: [userMessage(screenText(input), input)],
    schema: screenSummarySchema,
    task: { kind: 'describe_screen', input },
  }
}
