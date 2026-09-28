import { defineConfig } from 'vitest/config'
import { sharedTestConfig } from './vitest.shared.ts'

// One Vitest run for the whole monorepo; each directory below has its own vitest.config.ts.
export default defineConfig({
  test: {
    projects: ['apps/*', 'packages/*', 'scripts'],
    passWithNoTests: sharedTestConfig.passWithNoTests,
  },
})
