import type { ElementNode } from '@coral/shared'
import { XMLParser } from 'fast-xml-parser'

interface RawNode {
  text?: string
  'resource-id'?: string
  class?: string
  package?: string
  'content-desc'?: string
  clickable?: string
  enabled?: string
  focused?: string
  scrollable?: string
  password?: string
  'visible-to-user'?: string
  bounds?: string
  'drawing-order'?: string
  node?: RawNode[]
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: false,
  // Keep text exactly as dumped (leading/trailing spaces, numbers like "10:24").
  trimValues: false,
  isArray: (name) => name === 'node',
})

const BOUNDS = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/

function parseBounds(raw: string | undefined): ElementNode['bounds'] {
  const m = BOUNDS.exec(raw ?? '')
  if (!m) return { x: 0, y: 0, w: 0, h: 0 }
  const [x1, y1, x2, y2] = m.slice(1).map(Number) as [number, number, number, number]
  return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) }
}

function toNode(raw: RawNode, ref: string, windowIndex: number): ElementNode {
  const bounds = parseBounds(raw.bounds)
  const visibleAttr = raw['visible-to-user']
  return {
    ref,
    platform_id: raw['resource-id'] ?? '',
    text: raw.text ?? '',
    desc: raw['content-desc'] ?? '',
    class: raw.class ?? '',
    bounds,
    clickable: raw.clickable === 'true',
    enabled: raw.enabled !== 'false',
    visible: visibleAttr === undefined ? bounds.w > 0 && bounds.h > 0 : visibleAttr === 'true',
    package_or_bundle: raw.package ?? '',
    children: (raw.node ?? []).map((child, i) => toNode(child, `${ref}.${i}`, windowIndex)),
    android: {
      password: raw.password === 'true',
      focused: raw.focused === 'true',
      scrollable: raw.scrollable === 'true',
      drawing_order: Number(raw['drawing-order'] ?? 0) || 0,
      window_index: windowIndex,
    },
  }
}

/**
 * `dumpWindowHierarchy` XML → top-level windows, bottom-most first (research R3).
 * `ref` is the index path within this dump (`0.3.1`).
 */
export function parseHierarchy(xml: string): ElementNode[] {
  const doc = parser.parse(xml) as { hierarchy?: { node?: RawNode[] } | '' }
  const windows = typeof doc.hierarchy === 'object' ? (doc.hierarchy.node ?? []) : []
  return windows.map((window, i) => toNode(window, String(i), i))
}
