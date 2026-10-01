import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve as resolvePath } from 'node:path'
import {
  DEFAULT_POPUPS_YAML,
  validatePopupsSource,
  validateTestCaseSource,
  type Popups,
  type TestCase,
} from '@coral/shared'
import {
  LocalDirSink,
  createPopupGuard,
  RunSetupError,
  missingSecrets,
  runTestCase,
  type ItemResult,
  type RunEvent,
} from '@coral/runner'
import { Command, Option } from 'commander'

import { AdbMissingError, type CliDeps, type RunnableDriver } from '../deps'
import type { CliIo } from '../io'
import { appMapScreensIn, assetsIn, fileExistsIn, projectRootOf } from '../project-root'
import { formatIssue } from './validate'

interface RunOptions {
  device?: string
  app: string
  apk?: string
  popups?: string
  out?: string
  stableTimeout: string
  format: 'text' | 'json'
  projectRoot?: string
}

/** `CORAL_SECRET_<NAME>` → `{ NAME: value }` (dev-only secret source, D19). */
export function secretsFromEnv(env: Record<string, string | undefined>): Record<string, string> {
  const secrets: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('CORAL_SECRET_') && value !== undefined) {
      secrets[key.slice('CORAL_SECRET_'.length)] = value
    }
  }
  return secrets
}

class UsageError extends Error {}

const stamp = (date: Date) => date.toISOString().replace(/[:.]/g, '-')

function formatStep(event: Extract<RunEvent, { type: 'step' }>): string {
  const r = event.result
  const mark = r.status === 'passed' ? '✓' : '✗'
  const extra = [
    r.degraded ? 'degraded' : '',
    r.unstable ? 'unstable' : '',
    r.popups_handled.length > 0 ? `popups: ${r.popups_handled.map((p) => p.rule).join(', ')}` : '',
  ].filter(Boolean)
  const failure = r.failure_code ? `  ${r.failure_code}: ${r.message ?? ''}` : ''
  return `  ${mark} ${r.step_id.padEnd(6)} ${r.action.padEnd(13)} ${(r.duration_ms / 1000).toFixed(1)}s${
    extra.length ? `  (${extra.join(', ')})` : ''
  }${failure}\n`
}

interface LoadedTestCase {
  testCase: TestCase
  root: string
  /** Fingerprints of the app map screens of that project (`expect.screen`, D24). */
  screens: Record<string, string>
}

/** The test cases with the project root their `image` paths and app map come from (FR-022). */
async function loadTestCases(
  files: string[],
  projectRoot: string | undefined,
): Promise<LoadedTestCase[]> {
  const loaded: LoadedTestCase[] = []
  const problems: string[] = []
  for (const file of files) {
    let source: string
    try {
      source = await readFile(file, 'utf8')
    } catch (error) {
      throw new UsageError(`cannot read ${file}: ${(error as Error).message}`)
    }
    const root = projectRootOf(file, projectRoot)
    let screens: Record<string, string>
    try {
      screens = appMapScreensIn(root)
    } catch (error) {
      throw new UsageError((error as Error).message)
    }
    const result = validateTestCaseSource(source, file, {
      fileExists: fileExistsIn(root),
      screenExists: (id) => screens[id] !== undefined,
    })
    if (!result.valid || !result.value) problems.push(...result.errors.map(formatIssue))
    else loaded.push({ testCase: result.value, root, screens })
  }
  if (problems.length > 0) throw new UsageError(`invalid test case:\n${problems.join('\n')}`)
  return loaded
}

async function loadPopups(file: string | undefined): Promise<Popups> {
  const source = file ? await readFile(file, 'utf8') : DEFAULT_POPUPS_YAML
  const result = validatePopupsSource(source, file ?? 'default popups')
  if (!result.valid || !result.value) {
    throw new UsageError(`invalid popup rules:\n${result.errors.map(formatIssue).join('\n')}`)
  }
  return result.value
}

async function pickDevice(deps: CliDeps, wanted: string | undefined): Promise<string> {
  const online = (await deps.listDevices()).filter((d) => d.state === 'device')
  if (wanted) {
    if (!online.some((d) => d.udid === wanted)) {
      throw new UsageError(`device ${wanted} is not online (see coral devices)`)
    }
    return wanted
  }
  const [only, ...others] = online
  if (!only) throw new UsageError('no online device (see coral devices)')
  if (others.length > 0) throw new UsageError('several devices online: choose one with --device')
  return only.udid
}

export function runCommand(io: CliIo, deps: () => CliDeps): Command {
  return new Command('run')
    .description('Run test cases on a local Android device (no server, no AI).')
    .argument('<testcase...>', 'coral/testcase@1 files')
    .option('--device <udid>', 'device (required when several are online)')
    .requiredOption('--app <package>', 'package of the app under test')
    .option('--apk <path>', 'install / update this build first')
    .option(
      '--popups <file>',
      'popup rules (default: bundled copy of examples/popups.example.yaml)',
    )
    .option('--out <dir>', 'result folder (default ./coral-results/<timestamp>/)')
    .option('--stable-timeout <ms>', 'max wait for a stable screen (§8.3)', '3000')
    .option(
      '--project-root <dir>',
      'where image locator paths start (default: the folder holding testcases/, or the YAML’s)',
    )
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .action(async (files: string[], options: RunOptions) => {
      const d = deps()
      let driver: RunnableDriver | undefined
      const results: ItemResult[] = []
      try {
        const stableTimeoutMs = Number(options.stableTimeout)
        if (!Number.isInteger(stableTimeoutMs) || stableTimeoutMs < 300) {
          throw new UsageError('--stable-timeout must be an integer ≥ 300')
        }
        // Everything that can be checked without a device comes first.
        const loaded = await loadTestCases(files, options.projectRoot)
        const testCases = loaded.map((l) => l.testCase)
        const popups = await loadPopups(options.popups)
        for (const testCase of testCases) {
          if (!testCase.platforms.includes('android')) {
            throw new UsageError(
              `platform_mismatch: ${testCase.id} targets ${testCase.platforms.join(', ')}, not android`,
            )
          }
        }
        const secrets = secretsFromEnv(d.env)
        const missing = [...new Set(testCases.flatMap((tc) => missingSecrets(tc, secrets)))]
        if (missing.length > 0) {
          throw new UsageError(
            `missing secrets: ${missing.map((name) => `CORAL_SECRET_${name}`).join(', ')}`,
          )
        }
        const build = options.apk
          ? {
              path: resolvePath(options.apk),
              sha256: createHash('sha256')
                .update(await readFile(options.apk))
                .digest('hex'),
            }
          : undefined

        const udid = await pickDevice(d, options.device)
        const out = resolvePath(options.out ?? join('coral-results', stamp(d.now())))
        const sink = new LocalDirSink(out)
        driver = await d.createDriver({ udid, appId: options.app })
        await driver.open()

        for (const [i, { testCase, root, screens }] of loaded.entries()) {
          if (options.format === 'text') io.out(`▶ ${testCase.id}  (${udid})\n`)
          const result = await runTestCase({
            driver,
            testCase,
            popupGuard: createPopupGuard({ popups, driver }),
            appId: options.app,
            secrets,
            sink,
            stableTimeoutMs,
            assets: assetsIn(root),
            screens,
            // Install once, before the first test case.
            ...(build && i === 0 ? { build } : {}),
            onEvent: (event) => {
              if (options.format === 'text' && event.type === 'step') io.out(formatStep(event))
            },
          })
          results.push(result)
          if (options.format === 'text') {
            io.out(
              `  ${result.status.toUpperCase()}${result.failure_code ? ` ${result.failure_code}` : ''}  ${(
                result.duration_ms / 1000
              ).toFixed(1)}s  → ${join(out, testCase.id)}\n`,
            )
          }
        }
        if (options.format === 'json') io.out(`${JSON.stringify({ out, results }, null, 2)}\n`)
        else {
          const passed = results.filter((r) => r.status === 'passed').length
          io.out(`${passed}/${results.length} passed\n`)
        }
        io.setExitCode(
          results.some((r) => r.status === 'error')
            ? 2
            : results.every((r) => r.status === 'passed')
              ? 0
              : 1,
        )
      } catch (error) {
        const known =
          error instanceof UsageError ||
          error instanceof RunSetupError ||
          error instanceof AdbMissingError
        io.err(`coral run: ${error instanceof Error ? error.message : String(error)}\n`)
        if (!known && error instanceof Error && error.stack) io.err(`${error.stack}\n`)
        io.setExitCode(2)
      } finally {
        await driver?.close().catch(() => undefined)
      }
    })
}
