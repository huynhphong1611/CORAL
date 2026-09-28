import { defineConfig } from 'vitest/config'

// One Vitest run for the whole monorepo; each directory below has its own vitest.config.ts.
export default defineConfig({
  test: {
    projects: ['apps/*', 'packages/*', 'scripts'],
  },
})
