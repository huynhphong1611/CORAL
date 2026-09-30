import { configDefaults } from 'vitest/config'

const DEVICE_TESTS = '**/*.device.test.ts'
const INT_TESTS = '**/*.int.test.ts'
/** Playwright specs (`pnpm test:e2e`), never picked up by Vitest. */
const E2E = 'e2e/**'

export interface TestSelection {
  include: string[]
  exclude: string[]
  passWithNoTests: boolean
}

/**
 * Which test files a Vitest run picks up (SPEC D21, D34):
 * - default: unit tests only — `*.test.ts(x)` minus integration and device tests;
 * - `CORAL_INT_TESTS=1` (`pnpm test:int`): only `*.int.test.ts` (needs Postgres/Redis/MinIO);
 * - `CORAL_DEVICE_TESTS=1` (`pnpm test:device`): only `*.device.test.ts` (needs a real device).
 */
export function testSelection(env: Record<string, string | undefined>): TestSelection {
  if (env.CORAL_DEVICE_TESTS === '1') {
    return {
      include: [DEVICE_TESTS],
      exclude: [...configDefaults.exclude, E2E],
      passWithNoTests: true,
    }
  }
  if (env.CORAL_INT_TESTS === '1') {
    return {
      include: [INT_TESTS],
      exclude: [...configDefaults.exclude, E2E],
      passWithNoTests: true,
    }
  }
  return {
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: [...configDefaults.exclude, DEVICE_TESTS, INT_TESTS, E2E],
    passWithNoTests: false,
  }
}

/**
 * Device test files share one device, so they run one after another (two files driving the same
 * emulator at once made `setText` miss its field in CI). Root-level option: not per project.
 */
export function fileParallelism(env: Record<string, string | undefined>): boolean {
  return env.CORAL_DEVICE_TESTS !== '1'
}

export const sharedTestConfig = testSelection(process.env)
