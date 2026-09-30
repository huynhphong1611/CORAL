import { describe, expect, it } from 'vitest'
import { examples } from '../testing/fixtures'
import { normalizeButtonText, validatePopupsSource } from './schema'

describe('coral/popups@1', () => {
  it('accepts examples/popups.example.yaml', () => {
    const result = validatePopupsSource(examples['popups.example.yaml'] ?? '', 'popups.yaml')
    expect(result.errors).toEqual([])
    expect(result.value?.rules.map((r) => r.name)).toContain('android_permission')
    expect(result.value?.never_tap).toContain('Thanh toán')
  })

  it('requires at least one match key and a button', () => {
    const result = validatePopupsSource(
      'schema: coral/popups@1\nrules:\n  - name: a\n    match: {}\n    tap_any: []\n',
      'p.yaml',
    )
    expect(result.errors.map((e) => e.path)).toEqual(['rules[0].match', 'rules[0].tap_any'])
  })

  it('rejects duplicate rule names and rules that tap a never_tap button', () => {
    const source = `schema: coral/popups@1
rules:
  - name: promo
    match: { text_contains: 'Ưu đãi' }
    tap_any: ['Để sau', '  THANH   toán ']
  - name: promo
    match: { package: 'com.x' }
    tap_any: ['OK']
never_tap: ['Thanh toán']
`
    const result = validatePopupsSource(source, 'popups.yaml')
    expect(result.errors.map((e) => [e.code, e.path, e.line])).toEqual([
      ['rule_taps_never_tap', 'rules[0].tap_any[1]', 5],
      ['duplicate_rule_name', 'rules[1].name', 6],
    ])
  })

  it('normalizes button text for comparison', () => {
    expect(normalizeButtonText('  Cho   PHÉP ')).toBe(normalizeButtonText('cho phép'))
    expect(normalizeButtonText('Allow all')).not.toBe(normalizeButtonText('Allow'))
  })
})
