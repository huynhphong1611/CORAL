import { hashPassword } from './auth/password'
import { loadConfig } from './config'
import { identityRepo } from './repos/identity'
import { createDatabase } from './db/client'

/** `pnpm --filter @coral/server db:seed`: creates the operator account once (idempotent). */
const config = loadConfig(process.env)
const { email, password } = config.seed
if (!email || !password) {
  console.error('Set CORAL_SEED_EMAIL and CORAL_SEED_PASSWORD (≥ 8 chars) in .env first.')
  process.exit(1)
}
const database = createDatabase(config.databaseUrl)
try {
  const result = await identityRepo(database.db).seedOwner({
    email,
    passwordHash: await hashPassword(password),
    name: email.split('@')[0] ?? email,
    tenantName: 'default',
  })
  console.log(result.created ? `Seeded owner ${email}.` : `Owner ${email} already exists.`)
} finally {
  await database.close()
}
