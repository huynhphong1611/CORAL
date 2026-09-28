import { CORAL_VERSION } from '@coral/shared'
import { Command, CommanderError } from 'commander'
import { devicesCommand } from './commands/devices'
import { runCommand } from './commands/run'
import { validateCommand } from './commands/validate'
import { defaultDeps, type CliDeps } from './deps'
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
export function createProgram(
  io: CliIo = processIo,
  deps: () => CliDeps = () => defaultDeps(),
): Command {
  const program = new Command('coral')
    .description('coral — tests that grow back. AI-assisted mobile UI testing.')
    .version(CORAL_VERSION, '-v, --version')
    .showHelpAfterError()
    .exitOverride(usageExit)
    .addCommand(validateCommand(io))
    .addCommand(devicesCommand(io, deps))
    .addCommand(runCommand(io, deps))
  for (const command of program.commands) command.showHelpAfterError().exitOverride(usageExit)
  return program
}
