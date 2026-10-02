import { toJsonSchema } from '@coral/shared'
import type { z } from 'zod'
import type { ChatMessage, ChatTask, ProjectKnowledge, ScreenElement, ScreenInput } from '../brain'

/**
 * Provider-neutral prompts (research R6). The stable part — role, `AGENTS.md`, the skill list and
 * named test data — comes first so providers can cache it; what changes each call comes after.
 */

/** `AGENTS.md` beyond this is cut (research R6). */
export const MAX_AGENTS_MD_CHARS = 16 * 1024
export const MAX_SKILLS_LISTED = 50
/** Elements listed for one screen (research R6). */
export const MAX_ELEMENTS = 80
const MAX_VISIBLE_TEXTS = 50

/** The project's own words for every role: AGENTS.md, skills, named test data (§13). */
export function projectContext(knowledge: ProjectKnowledge): string {
  const parts: string[] = []
  const agents = knowledge.agentsMd.trim().slice(0, MAX_AGENTS_MD_CHARS)
  if (agents) parts.push(`## Project rules (AGENTS.md)\n${agents}`)
  const skills = knowledge.skills.slice(0, MAX_SKILLS_LISTED)
  if (skills.length > 0) {
    parts.push(
      `## Skills (read one with the read_skill tool)\n${skills
        .map((s) => `- ${s.name}: ${s.description}`)
        .join('\n')}`,
    )
  }
  if (knowledge.testData.length > 0) {
    parts.push(
      `## Test data\n${knowledge.testData
        .map((d) =>
          d.secret !== undefined
            ? `- ${d.name}: secret ${d.secret} (type it with "secret": "${d.secret}")`
            : `- ${d.name}: ${JSON.stringify(d.value ?? '')}`,
        )
        .join('\n')}`,
    )
  }
  return parts.join('\n\n')
}

/** Role instructions, then the project context: identical for every call of an activity. */
export function stableSystem(role: string, knowledge: ProjectKnowledge): string {
  return [role, projectContext(knowledge)].filter(Boolean).join('\n\n')
}

export const quote = (value: string) => JSON.stringify(value)

/** `#4 EditText id="passwordET" text="…" [60,860,960,120] field password` (contracts/brain.md §2). */
export function elementLine(element: ScreenElement): string {
  const parts = [`#${element.n}`, element.className]
  if (element.id) parts.push(`id=${quote(element.id)}`)
  if (element.text) parts.push(`text=${quote(element.text)}`)
  if (element.desc) parts.push(`desc=${quote(element.desc)}`)
  parts.push(`[${element.bounds.join(',')}]`)
  parts.push(...element.flags)
  return parts.join(' ')
}

export function screenText(screen: ScreenInput): string {
  const header = `Screen ${screen.width}x${screen.height} · app ${screen.appPackage} · ${
    screen.knownAs ? `known as ${quote(screen.knownAs)}` : 'new screen'
  }`
  const elements = screen.elements.slice(0, MAX_ELEMENTS).map(elementLine)
  const texts = screen.visibleTexts.slice(0, MAX_VISIBLE_TEXTS).map((t) => t.text)
  const forbidden = screen.forbidden ?? []
  return [
    header,
    elements.length > 0 ? elements.join('\n') : '(no element can be used: tap_point only)',
    texts.length > 0 ? `Visible text: ${texts.map(quote).join(', ')}` : '',
    forbidden.length > 0
      ? `Never to be tapped here (project rules): ${forbidden.map(quote).join(', ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export function userMessage(text: string, screen?: ScreenInput): ChatMessage {
  return { role: 'user', text, ...(screen?.image ? { images: [screen.image] } : {}) }
}

/** Everything one `Brain` method sends: prompt, answer schema and the task for the fake adapter. */
export interface Prompt<T> {
  system: { stable: string; volatile: string }
  messages: ChatMessage[]
  schema: z.ZodType<T>
  task: ChatTask
}

/** The JSON Schema a provider gets for an answer schema. */
export const outputSchemaOf = (schema: z.ZodType) => toJsonSchema(schema)
