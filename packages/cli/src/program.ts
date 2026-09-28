import { CORAL_VERSION } from '@coral/shared'
import { Command } from 'commander'

/**
 * Builds the `coral` command tree. Commands arrive with their phases:
 * `validate` and `run` in Phase 1 (docs/ROADMAP.md).
 */
export function createProgram(): Command {
  return new Command('coral')
    .description('coral — tests that grow back. AI-assisted mobile UI testing.')
    .version(CORAL_VERSION, '-v, --version')
    .showHelpAfterError()
}
