import { readFileSync } from 'node:fs'
import { validatePopupsSource } from '@coral/shared'
import { describe, expect, it } from 'vitest'
import { DEFAULT_POPUPS_YAML } from './default-popups'

describe('bundled popup rules', () => {
  it('match examples/popups.example.yaml and are valid', () => {
    const example = readFileSync(
      new URL('../../../../examples/popups.example.yaml', import.meta.url),
      'utf8',
    )
    expect(DEFAULT_POPUPS_YAML).toBe(example)
    expect(validatePopupsSource(DEFAULT_POPUPS_YAML, 'default').valid).toBe(true)
  })
})
