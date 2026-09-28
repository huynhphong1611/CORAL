#!/usr/bin/env node
import { CommanderError } from 'commander'
import { createProgram } from './program'

try {
  await createProgram().parseAsync(process.argv)
} catch (error) {
  if (!(error instanceof CommanderError)) throw error
  process.exitCode = error.exitCode
}
