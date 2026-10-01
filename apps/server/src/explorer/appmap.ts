import {
  APPMAP_SCHEMA_ID,
  EMPTY_APPMAP,
  MAX_APPMAP_SCREENS,
  MAX_APPMAP_TRANSITIONS,
  appMapSchema,
  screenSlug,
  type AppMap,
  type AppMapScreen,
  type TransitionAction,
} from '@coral/shared'
import type { GitAuthor, ProjectRepoStore } from '../git/project-repo-store'

export const APPMAP_PATH = 'appmap/screens.json'
export const appMapSnapshotDir = (id: string) => `appmap/snap/${id}`

/** A screen an exploration saw, under the id it gave it while running. */
export interface SeenScreen {
  fingerprint: string
  id: string
  name: string
  package: string
  activity?: string
  firstSeenAt: Date
  /** `screen.jpg` and `tree.json` of the first time it was seen (copied for new screens). */
  snapshot?: { screen: Uint8Array; tree: Uint8Array | string }
}

export interface SeenTransition {
  from: string
  to: string
  /** The recorded step, without id, expectation or snapshot. */
  action: TransitionAction
}

export interface MergeResult {
  map: AppMap
  /** Fingerprint → id in the merged map (an id seen while running may change). */
  ids: Map<string, string>
  /** Screens this exploration added. */
  added: SeenScreen[]
  /** The limits of 500 screens / 5 000 transitions were reached. */
  full: boolean
}

/** The id for `name`: its slug, with `-2`, `-3`… when another screen has it. */
export function freeScreenId(taken: ReadonlySet<string>, name: string, preferred?: string): string {
  if (preferred && !taken.has(preferred)) return preferred
  const base = screenSlug(name)
  if (!taken.has(base)) return base
  for (let i = 2; ; i += 1) {
    const suffix = `-${i}`
    const id = `${base.slice(0, 50 - suffix.length).replace(/-+$/, '')}${suffix}`
    if (!taken.has(id)) return id
  }
}

/** Transitions are the same when they join the same screens through the same first locator. */
function transitionKey(from: string, to: string, action: TransitionAction): string {
  const target = (action as { target?: readonly unknown[] }).target
  return JSON.stringify([from, to, target?.[0] ?? action.action])
}

/**
 * Merges what one exploration saw into the app map (contracts/appmap.md): screens match by
 * fingerprint and keep their id, name and snapshot, only adding `seen_in`; new screens get a free
 * id; transitions are unique by (from, to, first locator). Past the limits nothing new is added.
 */
export function mergeAppMap(
  base: AppMap,
  seen: { screens: readonly SeenScreen[]; transitions: readonly SeenTransition[] },
  explorationId: string,
): MergeResult {
  const screens: AppMapScreen[] = base.screens.map((s) => ({ ...s, seen_in: [...s.seen_in] }))
  const transitions = base.transitions.map((t) => ({ ...t, seen_in: [...t.seen_in] }))
  const byFingerprint = new Map(screens.map((s) => [s.fingerprint, s]))
  const taken = new Set(screens.map((s) => s.id))
  const ids = new Map<string, string>()
  const added: SeenScreen[] = []
  let full = false
  const mark = (list: string[]) => {
    if (!list.includes(explorationId)) list.push(explorationId)
  }

  for (const screen of seen.screens) {
    const known = byFingerprint.get(screen.fingerprint)
    if (known) {
      mark(known.seen_in)
      ids.set(screen.fingerprint, known.id)
      continue
    }
    if (screens.length >= MAX_APPMAP_SCREENS) {
      full = true
      continue
    }
    const id = freeScreenId(taken, screen.name, screen.id)
    taken.add(id)
    const entry: AppMapScreen = {
      id,
      name: screen.name.slice(0, 60),
      fingerprint: screen.fingerprint,
      package: screen.package,
      ...(screen.activity ? { activity: screen.activity } : {}),
      snapshot: appMapSnapshotDir(id),
      first_seen_at: screen.firstSeenAt.toISOString(),
      seen_in: [explorationId],
    }
    screens.push(entry)
    byFingerprint.set(screen.fingerprint, entry)
    ids.set(screen.fingerprint, id)
    added.push({ ...screen, id })
  }

  const keys = new Map(transitions.map((t) => [transitionKey(t.from, t.to, t.action), t]))
  for (const t of seen.transitions) {
    const from = ids.get(t.from)
    const to = ids.get(t.to)
    if (!from || !to || from === to) continue
    const key = transitionKey(from, to, t.action)
    const existing = keys.get(key)
    if (existing) {
      mark(existing.seen_in)
      continue
    }
    if (transitions.length >= MAX_APPMAP_TRANSITIONS) {
      full = true
      continue
    }
    const entry = { from, to, action: t.action, seen_in: [explorationId] }
    transitions.push(entry)
    keys.set(key, entry)
  }

  return { map: { schema: APPMAP_SCHEMA_ID, screens, transitions }, ids, added, full }
}

/** The app map in a file, or the empty one; a broken file is an error, never overwritten. */
export function parseAppMap(text: string | null): AppMap {
  if (text === null) return EMPTY_APPMAP
  return appMapSchema.parse(JSON.parse(text) as unknown)
}

/**
 * Merges and commits in one go, under the project's write lock, so two explorations finishing
 * together both land (FR-027): `appmap/screens.json` and the pictures of new screens.
 */
export async function commitAppMap(
  store: ProjectRepoStore,
  input: {
    tenantId: string
    projectId: string
    explorationId: string
    screens: readonly SeenScreen[]
    transitions: readonly SeenTransition[]
    author: GitAuthor
  },
): Promise<MergeResult & { commit: string | null }> {
  let result: MergeResult | undefined
  const commit = await store.updateFiles(input.tenantId, input.projectId, async (read) => {
    result = mergeAppMap(parseAppMap(await read(APPMAP_PATH)), input, input.explorationId)
    if (input.screens.length === 0) return null
    const files: Record<string, string | Uint8Array> = {
      [APPMAP_PATH]: `${JSON.stringify(result.map, null, 2)}\n`,
    }
    for (const screen of result.added) {
      if (!screen.snapshot) continue
      files[`${appMapSnapshotDir(screen.id)}/screen.jpg`] = screen.snapshot.screen
      files[`${appMapSnapshotDir(screen.id)}/tree.json`] = screen.snapshot.tree
    }
    return {
      files,
      author: input.author,
      message: `appmap: exploration ${input.explorationId.slice(-8)} (${result.added.length} new screen(s))`,
    }
  })
  if (!result) throw new Error('app map not merged')
  return { ...result, commit }
}
