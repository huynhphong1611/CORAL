import { describe, expect, it } from 'vitest'
import { fileParallelism, testSelection } from '../vitest.shared.ts'

describe('testSelection (D21, D34)', () => {
  it('runs only unit tests by default', () => {
    const selection = testSelection({})
    expect(selection.include).toEqual(['**/*.test.ts', '**/*.test.tsx'])
    expect(selection.exclude).toEqual(
      expect.arrayContaining(['**/*.device.test.ts', '**/*.int.test.ts']),
    )
    expect(selection.passWithNoTests).toBe(false)
  })

  it('never picks up Playwright specs (e2e/**, pnpm test:e2e)', () => {
    for (const env of [{}, { CORAL_INT_TESTS: '1' }, { CORAL_DEVICE_TESTS: '1' }]) {
      expect(testSelection(env).exclude).toContain('e2e/**')
    }
  })

  it('runs only integration tests with CORAL_INT_TESTS=1', () => {
    const selection = testSelection({ CORAL_INT_TESTS: '1' })
    expect(selection.include).toEqual(['**/*.int.test.ts'])
    expect(selection.passWithNoTests).toBe(true)
  })

  it('runs only device tests with CORAL_DEVICE_TESTS=1, one file at a time', () => {
    expect(testSelection({ CORAL_DEVICE_TESTS: '1' }).include).toEqual(['**/*.device.test.ts'])
    expect(fileParallelism({ CORAL_DEVICE_TESTS: '1' })).toBe(false)
    expect(fileParallelism({})).toBe(true)
    expect(fileParallelism({ CORAL_INT_TESTS: '1' })).toBe(true)
  })
})
