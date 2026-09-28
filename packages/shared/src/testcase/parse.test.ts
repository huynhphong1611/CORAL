import { describe, expect, it } from 'vitest'
import { parseYaml } from './parse'

const source = `schema: coral/testcase@1
steps:
  - id: s1
    action: launch
  - id: s2
    action: tap
    target:
      - text: 'Đăng nhập'
      - point_pct: [0.5, 0.5]
`

describe('parseYaml', () => {
  it('returns the plain value', () => {
    expect(parseYaml(source).value).toMatchObject({ steps: [{ id: 's1' }, { id: 's2' }] })
  })

  it('maps error paths to line/column', () => {
    const { positionOf } = parseYaml(source)
    expect(positionOf(['steps', 1, 'target', 1])).toEqual({ line: 9, column: 9 })
    expect(positionOf(['steps', 1, 'action'])).toEqual({ line: 6, column: 5 })
    expect(positionOf(['schema'])).toEqual({ line: 1, column: 1 })
  })

  it('falls back to the closest existing node for missing keys', () => {
    const { positionOf } = parseYaml(source)
    expect(positionOf(['steps', 0, 'target'])).toEqual({ line: 3, column: 5 })
  })

  it('reports syntax errors and duplicate keys with positions', () => {
    const broken = parseYaml('a: 1\nb: [1, 2\n')
    expect(broken.value).toBeUndefined()
    expect(broken.errors[0]?.line).toBeGreaterThan(0)
    expect(broken.errors[0]?.column).toBeGreaterThan(0)
    expect(parseYaml('a: 1\na: 2\n').errors[0]?.line).toBe(2)
  })
})
