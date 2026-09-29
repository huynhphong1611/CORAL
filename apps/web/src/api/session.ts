import type { api } from '@coral/shared'

export type SessionStatus = 'loading' | 'signed_in' | 'signed_out'
export interface SessionSnapshot {
  status: SessionStatus
  session: api.Session | null
}

/**
 * Who is signed in, for React (useSyncExternalStore) and the router guard. Starts `loading`
 * until the first refresh answers (a reload keeps the session through the refresh cookie).
 */
export class SessionStore {
  private snapshot: SessionSnapshot = { status: 'loading', session: null }
  private readonly listeners = new Set<() => void>()

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): SessionSnapshot => this.snapshot

  get signedIn(): boolean {
    return this.snapshot.status === 'signed_in'
  }

  set(session: api.Session | null): void {
    this.snapshot = { status: session ? 'signed_in' : 'signed_out', session }
    for (const listener of this.listeners) listener()
  }
}
