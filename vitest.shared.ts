import { configDefaults } from 'vitest/config'

/**
 * Test file selection shared by every Vitest project (SPEC D21).
 * Tests that need a real device live in `*.device.test.ts` and only run when
 * CORAL_DEVICE_TESTS=1 (`pnpm test:device`); CI never sets it.
 */
const DEVICE_TESTS = '**/*.device.test.ts'
const deviceMode = process.env.CORAL_DEVICE_TESTS === '1'

export const sharedTestConfig = {
  include: deviceMode ? [DEVICE_TESTS] : ['**/*.test.ts', '**/*.test.tsx'],
  exclude: deviceMode ? [...configDefaults.exclude] : [...configDefaults.exclude, DEVICE_TESTS],
  passWithNoTests: deviceMode,
}
