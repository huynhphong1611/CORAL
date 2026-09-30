import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema'

export type Schema = typeof schema
export type Db = NodePgDatabase<Schema>
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export interface Database {
  db: Db
  pool: pg.Pool
  close(): Promise<void>
}

/** Opens a pooled connection. Only repositories (src/repos) may use it (constitution V). */
export function createDatabase(databaseUrl: string): Database {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 })
  const db = drizzle(pool, { schema, casing: 'snake_case' })
  return { db, pool, close: () => pool.end() }
}
