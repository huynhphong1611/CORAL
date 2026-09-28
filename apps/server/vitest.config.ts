import { defineProject } from 'vitest/config'
import { sharedTestConfig } from '../../vitest.shared.ts'

export default defineProject({
  test: { ...sharedTestConfig, name: 'server', environment: 'node' },
})
