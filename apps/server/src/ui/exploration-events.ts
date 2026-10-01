import type { protocol } from '@coral/shared'
import type { Db } from '../db/client'
import type { ExplorationEvents } from '../explorer/service'
import { HttpError } from '../http/errors'
import { explorationsRepo } from '../repos/explorations'
import type { UiGateway } from './gateway'
import { MAX_WATCHES_PER_CONNECTION } from './run-events'

type EventType = 'exploration.updated' | 'exploration.step' | 'exploration.screen'

/**
 * Exploration progress to browsers (contracts/ui-ws.md, T033): `exploration.watch` subscribes a
 * tab to one exploration of its tenant — it gets the state now, then `exploration.updated`,
 * `exploration.step` and `exploration.screen` as the Explorer emits them. The trace itself is read
 * over REST (`GET /explorations/:id/steps?after=`), so a step emitted while the watch is being set
 * up is not lost to the page.
 */
export class ExplorationWatchers implements ExplorationEvents {
  private readonly watchers = new Map<string, Set<string>>()
  private readonly watching = new Map<string, Set<string>>()

  constructor(private readonly options: { db: Db; ui: UiGateway }) {
    const { ui } = options
    ui.on('exploration.watch', async (ctx, message) => {
      const id = message.payload.exploration_id
      const { user } = ctx.connection
      let row
      try {
        row = await explorationsRepo(options.db, user.tenantId).get(id)
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) {
          ctx.fail('not_found', 'exploration not found')
          return
        }
        throw error
      }
      const mine = this.watching.get(ctx.connection.id) ?? new Set<string>()
      if (!mine.has(id) && mine.size >= MAX_WATCHES_PER_CONNECTION) {
        ctx.fail(
          'too_many_watches',
          `at most ${MAX_WATCHES_PER_CONNECTION} explorations per connection`,
        )
        return
      }
      mine.add(id)
      this.watching.set(ctx.connection.id, mine)
      const set = this.watchers.get(id) ?? new Set<string>()
      set.add(ctx.connection.id)
      this.watchers.set(id, set)
      ui.sendTo(ctx.connection.id, 'exploration.updated', {
        exploration_id: row.id,
        status: row.status,
        ...(row.stopReason ? { stop_reason: row.stopReason } : {}),
        stats: row.stats,
      })
    })
    ui.on('exploration.unwatch', (ctx, message) => {
      this.unwatch(ctx.connection.id, message.payload.exploration_id)
    })
    ui.onClose((connection) => {
      for (const id of this.watching.get(connection.id) ?? []) this.unwatch(connection.id, id)
      this.watching.delete(connection.id)
    })
  }

  emit<T extends EventType>(tenantId: string, type: T, payload: protocol.UiPayload<T>): void {
    const id = payload.exploration_id
    for (const connectionId of [...(this.watchers.get(id) ?? [])]) {
      // A watch is only ever set up for an exploration of the connection's own tenant (P5).
      const connection = this.options.ui.connectionsOf(tenantId).find((c) => c.id === connectionId)
      if (!connection || !this.options.ui.sendTo(connectionId, type, payload)) {
        this.unwatch(connectionId, id)
      }
    }
  }

  private unwatch(connectionId: string, id: string): void {
    this.watching.get(connectionId)?.delete(id)
    const set = this.watchers.get(id)
    set?.delete(connectionId)
    if (set?.size === 0) this.watchers.delete(id)
  }
}
