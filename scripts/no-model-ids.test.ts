// T021 (CLAUDE.md, research R2): no AI model name is written in the brain layer — the model of
// every call comes from the tenant's brains config. Scans packages/brain/src for strings that
// look like a model id of a provider.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const MODEL_ID =
  /\b(?:claude-(?:opus|sonnet|haiku|fable|mythos|\d)|gemini-\d|gpt-\d|o\d-mini)[\w.-]*/gi

/** Every .ts file under `dir`. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

/** `file:line: id` for every model id in the files. */
function modelIds(files: string[]): string[] {
  return files.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, i) =>
        [...line.matchAll(MODEL_ID)].map((m) => `${relative(root, file)}:${i + 1}: ${m[0]}`),
      ),
  )
}

describe('no hard-coded model names (CLAUDE.md)', () => {
  it('finds none in packages/brain/src', () => {
    const files = sources(join(root, 'packages/brain/src'))
    expect(files.length).toBeGreaterThan(5)
    expect(modelIds(files)).toEqual([])
  })

  it('would see one', () => {
    const line = (id: string) => [...id.matchAll(MODEL_ID)].map((m) => m[0])
    expect(line("model: 'claude-sonnet-5-5'")).toEqual(['claude-sonnet-5-5'])
    expect(line('const m = "gemini-2.5-flash"')).toEqual(['gemini-2.5-flash'])
    expect(line('gpt-5 or claude-3-haiku')).toEqual(['gpt-5', 'claude-3-haiku'])
    expect(line("id: 'claude', name: 'gemini'")).toEqual([])
  })
})
