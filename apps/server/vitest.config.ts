import { defineProject } from 'vitest/config'
import { sharedTestConfig } from '../../vitest.shared.ts'

const integration = process.env.CORAL_INT_TESTS === '1'

export default defineProject({
  test: {
    ...sharedTestConfig,
    name: 'server',
    environment: 'node',
    // Integration tests share one database: migrate once, run files one at a time.
    ...(integration
      ? { globalSetup: ['./src/db/test-global-setup.ts'], fileParallelism: false }
      : {}),
  },
})
