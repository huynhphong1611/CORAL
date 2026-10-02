import type { protocol } from '@coral/shared'
import type { Db } from '../db/client'
import { HttpError } from '../http/errors'
import type { ImportEvents } from '../imports/service'
import { importsRepo } from '../repos/imports'
import type { UiGateway } from './gateway'
import { MAX_WATCHES_PER_CONNECTION } from './run-events'

/**
 * Import progress to browsers (contracts/ui-ws-phase3.md): `import.watch` subscribes a tab to one
 * import job of its tenant — it gets the state now, then `import.updated` as each case ends. The
 * cases themselves are read over REST (`GET /imports/:id`).
 */
export class ImportWatchers implements ImportEvents {
  private readonly watchers = new Map<string, Set<string>>()
  private readonly watching = new Map<string, Set<string>>()

  constructor(private readonly options: { db: Db; ui: UiGateway }) {
    const { ui } = options
    ui.on('import.watch', async (ctx, message) => {
      const id = message.payload.import_job_id
      const { user } = ctx.connection
      let row
      try {
        row = await importsRepo(options.db, user.tenantId).getJob(id)
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) {
          ctx.fail('not_found', 'import not found')
          return
        }
        throw error
      }
      const mine = this.watching.get(ctx.connection.id) ?? new Set<string>()
      if (!mine.has(id) && mine.size >= MAX_WATCHES_PER_CONNECTION) {
        ctx.fail('too_many_watches', `at most ${MAX_WATCHES_PER_CONNECTION} imports per connection`)
        return
      }
      mine.add(id)
      this.watching.set(ctx.connection.id, mine)
      const set = this.watchers.get(id) ?? new Set<string>()
      set.add(ctx.connection.id)
      this.watchers.set(id, set)
      ui.sendTo(ctx.connection.id, 'import.updated', {
        import_job_id: row.id,
        status: row.status,
        stats: row.stats,
      })
    })
    ui.on('import.unwatch', (ctx, message) => {
      this.unwatch(ctx.connection.id, message.payload.import_job_id)
    })
    ui.onClose((connection) => {
      for (const id of this.watching.get(connection.id) ?? []) this.unwatch(connection.id, id)
      this.watching.delete(connection.id)
    })
  }

  emit(tenantId: string, payload: protocol.UiPayload<'import.updated'>): void {
    const id = payload.import_job_id
    for (const connectionId of [...(this.watchers.get(id) ?? [])]) {
      // A watch is only ever set up for an import of the connection's own tenant (P5).
      const connection = this.options.ui.connectionsOf(tenantId).find((c) => c.id === connectionId)
      if (!connection || !this.options.ui.sendTo(connectionId, 'import.updated', payload)) {
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
