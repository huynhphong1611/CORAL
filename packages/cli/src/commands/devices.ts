import { Command, Option } from 'commander'
import type { CliDeps } from '../deps'
import type { CliIo } from '../io'

export function devicesCommand(io: CliIo, deps: () => CliDeps): Command {
  return new Command('devices')
    .description('List Android devices visible to adb (model, Android version, API level).')
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .action(async (options: { format: 'text' | 'json' }) => {
      let rows
      try {
        rows = await deps().listDevices()
      } catch (error) {
        io.err(`coral devices: ${(error as Error).message}\n`)
        io.setExitCode(2)
        return
      }
      if (options.format === 'json') {
        io.out(`${JSON.stringify({ devices: rows }, null, 2)}\n`)
      } else if (rows.length === 0) {
        io.out('No devices. Start an emulator or connect a phone with USB debugging on.\n')
      } else {
        const lines = [
          ['UDID', 'STATE', 'KIND', 'MODEL', 'ANDROID', 'API'],
          ...rows.map((r) => [
            r.udid,
            r.state,
            r.kind ?? '-',
            r.model ?? '-',
            r.os_version ?? '-',
            r.api_level === undefined ? '-' : String(r.api_level),
          ]),
        ]
        const widths =
          lines[0]?.map((_, i) => Math.max(...lines.map((l) => (l[i] ?? '').length))) ?? []
        for (const line of lines) {
          io.out(
            `${line
              .map((cell, i) => cell.padEnd(widths[i] ?? 0))
              .join('  ')
              .trimEnd()}\n`,
          )
        }
      }
      io.setExitCode(0)
    })
}
