import { describe, expect, it } from 'vitest'
import { examples } from '../testing/fixtures'
import { DEFAULT_POPUPS_YAML } from './default'
import { validatePopupsSource } from './schema'

describe('default popup rules', () => {
  it('match examples/popups.example.yaml and are valid', () => {
    expect(DEFAULT_POPUPS_YAML).toBe(examples['popups.example.yaml'])
    expect(validatePopupsSource(DEFAULT_POPUPS_YAML, 'default').valid).toBe(true)
  })
})
