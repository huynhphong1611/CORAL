import { describe, expect, it } from 'vitest'
import { elementTreeSchema, walkTree, type ElementNode } from './element'

function node(ref: string, children: ElementNode[] = []): ElementNode {
  return {
    ref,
    platform_id: '',
    text: '',
    desc: '',
    class: 'android.widget.FrameLayout',
    bounds: { x: 0, y: 0, w: 10, h: 10 },
    clickable: false,
    enabled: true,
    visible: true,
    package_or_bundle: 'com.example',
    children,
  }
}

describe('element tree', () => {
  it('validates a nested tree.json', () => {
    const tree = [node('0', [node('0.0'), node('0.1', [node('0.1.0')])])]
    expect(elementTreeSchema.parse(tree)).toEqual(tree)
  })

  it('rejects negative sizes', () => {
    const bad = { ...node('0'), bounds: { x: 0, y: 0, w: -1, h: 10 } }
    expect(elementTreeSchema.safeParse([bad]).success).toBe(false)
  })

  it('walks depth-first in dump order', () => {
    const tree = [node('0', [node('0.0', [node('0.0.0')]), node('0.1')]), node('1')]
    expect([...walkTree(tree)].map((n) => n.ref)).toEqual(['0', '0.0', '0.0.0', '0.1', '1'])
  })
})
