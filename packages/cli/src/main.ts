#!/usr/bin/env node
import { CommanderError } from 'commander'
import { existsSync } from 'node:fs'
import { createProgram } from './program'

// CORAL_* settings and dev secrets (CORAL_SECRET_<NAME>) may live in .env (contracts/cli.md).
if (existsSync('.env')) process.loadEnvFile('.env')

try {
  await createProgram().parseAsync(process.argv)
} catch (error) {
  if (!(error instanceof CommanderError)) throw error
  process.exitCode = error.exitCode
}
