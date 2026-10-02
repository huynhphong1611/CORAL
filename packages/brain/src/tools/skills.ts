import type { ToolOutcome, ToolSet, ToolSpec } from '../brain'

export const READ_SKILL = 'read_skill'
/** A tool result the AI reads is cut here (contracts/brain.md §4). */
export const MAX_TOOL_RESULT = 8 * 1024

const blocked = (error: 'not_allowed'): ToolOutcome => ({
  result: JSON.stringify({ error }),
  ok: false,
  blocked: true,
  error,
})

/**
 * `read_skill { name }` (research R6): the content of one skill of the project being run. The AI
 * sees every skill's name and description in the prompt and reads the ones it needs; each read
 * is a tool round.
 */
export function skillTools(skills: ReadonlyMap<string, string>): ToolSet {
  const spec: ToolSpec = {
    name: READ_SKILL,
    description: 'Read the instructions of one skill of this project, by its name.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', enum: [...skills.keys()] } },
      required: ['name'],
      additionalProperties: false,
    },
  }
  return {
    specs: skills.size > 0 ? [spec] : [],
    call(name, args) {
      if (name !== READ_SKILL || skills.size === 0) return Promise.resolve(blocked('not_allowed'))
      const wanted = (args as { name?: unknown } | null)?.name
      const body = typeof wanted === 'string' ? skills.get(wanted) : undefined
      if (body === undefined) {
        return Promise.resolve({
          result: JSON.stringify({ error: 'unknown_skill', skills: [...skills.keys()] }),
          ok: false,
        })
      }
      return Promise.resolve({ result: body.slice(0, MAX_TOOL_RESULT), ok: true })
    },
  }
}

/** Several tool sets as one; a name none of them offers is blocked as not_allowed. */
export function combineTools(...sets: ToolSet[]): ToolSet {
  const owner = new Map<string, ToolSet>()
  for (const set of sets)
    for (const spec of set.specs) if (!owner.has(spec.name)) owner.set(spec.name, set)
  return {
    specs: [...owner.keys()].map(
      (name) => owner.get(name)?.specs.find((s) => s.name === name) as ToolSpec,
    ),
    call: (name, args) =>
      owner.get(name)?.call(name, args) ?? Promise.resolve(blocked('not_allowed')),
  }
}
