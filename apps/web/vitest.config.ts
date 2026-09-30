import { defineProject } from 'vitest/config'
import { sharedTestConfig } from '../../vitest.shared.ts'

// Components render in jsdom; plain modules run there too.
export default defineProject({
  test: { ...sharedTestConfig, name: 'web', environment: 'jsdom' },
})
