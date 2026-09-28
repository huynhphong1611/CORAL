import { readFile } from 'node:fs/promises'
import { validateDocumentSource, type ValidationIssue } from '@coral/shared'
import { Command, Option } from 'commander'
import type { CliIo } from '../io'

export interface FileReport {
  file: string
  valid: boolean
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}

/** One line per problem: `file:line:column  step_id  path  code  message` (contracts/cli.md). */
export function formatIssue(issue: ValidationIssue): string {
  const where =
    issue.line === undefined ? issue.file : `${issue.file}:${issue.line}:${issue.column}`
  return [where, issue.step_id ?? '-', issue.path || '-', issue.code, issue.message].join('  ')
}

export function validateCommand(io: CliIo): Command {
  return new Command('validate')
    .description('Check coral/testcase@1 and coral/popups@1 files (no device, no AI).')
    .argument('<file...>', 'YAML files to check')
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .action(async (files: string[], options: { format: 'text' | 'json' }) => {
      const reports: FileReport[] = []
      for (const file of files) {
        let source: string
        try {
          source = await readFile(file, 'utf8')
        } catch (error) {
          io.err(`coral validate: cannot read ${file}: ${(error as Error).message}\n`)
          io.setExitCode(2)
          return
        }
        const { valid, errors, warnings } = validateDocumentSource(source, file)
        reports.push({ file, valid, errors, warnings })
      }

      const errorCount = reports.reduce((n, r) => n + r.errors.length, 0)
      const warningCount = reports.reduce((n, r) => n + r.warnings.length, 0)
      if (options.format === 'json') {
        io.out(`${JSON.stringify({ files: reports }, null, 2)}\n`)
      } else {
        for (const report of reports) {
          for (const issue of report.errors) io.out(`${formatIssue(issue)}\n`)
          for (const issue of report.warnings) io.out(`${formatIssue(issue)}  (warning)\n`)
        }
        io.out(`${reports.length} files, ${errorCount} errors, ${warningCount} warnings\n`)
      }
      io.setExitCode(errorCount > 0 ? 1 : 0)
    })
}
