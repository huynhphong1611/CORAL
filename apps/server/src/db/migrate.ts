import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { createDatabase } from './client'

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('./migrations', import.meta.url))

/** Applies pending Drizzle migrations (never edits applied ones). */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const database = createDatabase(databaseUrl)
  try {
    await migrate(database.db, { migrationsFolder: MIGRATIONS_FOLDER })
  } finally {
    await database.close()
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { loadConfig } = await import('../config')
  await runMigrations(loadConfig(process.env).databaseUrl)
  console.log('migrations applied')
}
