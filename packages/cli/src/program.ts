import { CORAL_VERSION } from '@coral/shared'
import { Command, CommanderError } from 'commander'
import { validateCommand } from './commands/validate'
import { processIo, type CliIo } from './io'

/** Usage errors exit with 2 (contracts/cli.md); help and version still exit 0. */
function usageExit(error: CommanderError): never {
  if (error.exitCode === 0) throw error
  throw new CommanderError(2, error.code, error.message)
}

/**
 * Builds the `coral` command tree. Commands arrive with their phases:
 * `validate` and `run` in Phase 1 (docs/ROADMAP.md).
 */
export function createProgram(io: CliIo = processIo): Command {
  const program = new Command('coral')
    .description('coral — tests that grow back. AI-assisted mobile UI testing.')
    .version(CORAL_VERSION, '-v, --version')
    .showHelpAfterError()
    .exitOverride(usageExit)
    .addCommand(validateCommand(io))
  for (const command of program.commands) command.showHelpAfterError().exitOverride(usageExit)
  return program
}
