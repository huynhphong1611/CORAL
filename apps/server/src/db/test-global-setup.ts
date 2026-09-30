import { loadConfig } from '../config'
import { runMigrations } from './migrate'

/** Vitest global setup for *.int.test.ts: bring the database schema up to date once. */
export default async function setup(): Promise<void> {
  await runMigrations(loadConfig(process.env).databaseUrl)
}
