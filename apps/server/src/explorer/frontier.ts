/** Actions in a row that leave the screen as it was before the Explorer calls it stuck. */
export const STUCK_AFTER = 3

export type StuckRemedy = 'back' | 'restart_app'

/**
 * What the Explorer has covered (research R9, FR-024): per screen fingerprint the elements
 * already acted on and those that did nothing (key = first locator of the chain); how deep it is
 * since the app was last opened; and whether it is stuck — then a Back, and if that does not help,
 * a restart of the app.
 */
export class Frontier {
  /** Increases each time the app is opened fresh or restarted (trace segments). */
  segment = 1
  /** Forward screen changes since the app was last opened; a Back that changes screen undoes one. */
  depth = 0
  private readonly tried = new Map<string, Set<string>>()
  private readonly dead = new Map<string, Set<string>>()
  private unchanged = 0
  private backTried = false

  triedOn(fingerprint: string): ReadonlySet<string> {
    return this.tried.get(fingerprint) ?? new Set()
  }

  deadOn(fingerprint: string): ReadonlySet<string> {
    return this.dead.get(fingerprint) ?? new Set()
  }

  /**
   * One action done on screen `from` (on element `key`, when it had one), with the screen after
   * it. `treeChanged` says whether anything on screen changed at all (a field filled, a list
   * scrolled): an element is dead only when nothing did.
   */
  record(input: {
    from: string
    to: string
    key?: string
    back?: boolean
    treeChanged: boolean
  }): void {
    if (input.key !== undefined) {
      add(this.tried, input.from, input.key)
      if (input.from === input.to && !input.treeChanged) add(this.dead, input.from, input.key)
    }
    if (input.from !== input.to) {
      this.depth = input.back ? Math.max(0, this.depth - 1) : this.depth + 1
      this.unchanged = 0
      this.backTried = false
    } else if (!input.treeChanged) {
      this.unchanged += 1
    }
  }

  /** The app was opened again: a new segment from depth 0. */
  restarted(): void {
    this.segment += 1
    this.depth = 0
    this.unchanged = 0
    this.backTried = false
  }

  /** The system pressed Back itself to get unstuck. */
  backedOut(): void {
    this.backTried = true
    this.unchanged = 0
  }

  /** Beyond `max_depth` the AI may only go back (research R9). */
  overDepth(maxDepth: number): boolean {
    return this.depth >= maxDepth
  }

  /**
   * What the system does on its own: the app is gone → restart; another app is in front or three
   * actions changed nothing → Back, then a restart if Back already failed.
   */
  stuck(state: { appRunning: boolean; appInFront: boolean }): StuckRemedy | undefined {
    if (!state.appRunning) return 'restart_app'
    if (!state.appInFront || this.unchanged >= STUCK_AFTER) {
      return this.backTried ? 'restart_app' : 'back'
    }
    return undefined
  }
}

function add(map: Map<string, Set<string>>, fingerprint: string, key: string) {
  let set = map.get(fingerprint)
  if (!set) {
    set = new Set()
    map.set(fingerprint, set)
  }
  set.add(key)
}
