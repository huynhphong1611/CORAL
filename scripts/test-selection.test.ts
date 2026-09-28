import { describe, expect, it } from 'vitest'
import { testSelection } from '../vitest.shared.ts'

describe('testSelection (D21, D34)', () => {
  it('runs only unit tests by default', () => {
    const selection = testSelection({})
    expect(selection.include).toEqual(['**/*.test.ts', '**/*.test.tsx'])
    expect(selection.exclude).toEqual(
      expect.arrayContaining(['**/*.device.test.ts', '**/*.int.test.ts']),
    )
    expect(selection.passWithNoTests).toBe(false)
  })

  it('runs only integration tests with CORAL_INT_TESTS=1', () => {
    const selection = testSelection({ CORAL_INT_TESTS: '1' })
    expect(selection.include).toEqual(['**/*.int.test.ts'])
    expect(selection.passWithNoTests).toBe(true)
  })

  it('runs only device tests with CORAL_DEVICE_TESTS=1', () => {
    expect(testSelection({ CORAL_DEVICE_TESTS: '1' }).include).toEqual(['**/*.device.test.ts'])
  })
})
