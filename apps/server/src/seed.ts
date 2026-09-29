import { hashPassword } from './auth/password'
import { loadConfig } from './config'
import { identityRepo } from './repos/identity'
import { createDatabase } from './db/client'

/**
 * `pnpm --filter @coral/server db:seed`: creates the operator account once (idempotent). With
 * CORAL_SEED_TEAM_OF=<email of an existing user>, the account joins that user's tenant instead,
 * with CORAL_SEED_ROLE (default member) — a second person for dev and E2E.
 */
const config = loadConfig(process.env)
const { email, password, teamOf, role } = config.seed
if (!email || !password) {
  console.error('Set CORAL_SEED_EMAIL and CORAL_SEED_PASSWORD (≥ 8 chars) in .env first.')
  process.exit(1)
}
const database = createDatabase(config.databaseUrl)
try {
  const identity = identityRepo(database.db)
  const name = email.split('@')[0] ?? email
  const passwordHash = await hashPassword(password)
  if (teamOf) {
    const owner = await identity.findUserWithTenant(teamOf)
    if (!owner) {
      console.error(`No user ${teamOf} to add ${email} next to.`)
      process.exitCode = 1
    } else if (await identity.findUserWithTenant(email)) {
      console.log(`User ${email} already exists.`)
    } else {
      await identity.addMember({ tenantId: owner.tenant.id, email, passwordHash, name, role })
      console.log(`Added ${email} as ${role} of ${owner.tenant.name}.`)
    }
  } else {
    const result = await identity.seedOwner({
      email,
      passwordHash,
      name,
      tenantName: 'default',
    })
    console.log(result.created ? `Seeded owner ${email}.` : `Owner ${email} already exists.`)
  }
} finally {
  await database.close()
}
