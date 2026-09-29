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

/** A window as the window manager lists it (`dumpsys window windows`). */
export interface WindowLayer {
  package: string
  frame?: ElementNode['bounds']
}

/** What window ordering needs to know about a dumped window root. */
export interface WindowRoot {
  package: string
  bounds: ElementNode['bounds']
}

const WINDOW_HEADER = /^(\s*)Window #\d+ Window\{/
const LAYER_PACKAGE = /\bpackage=([\w.]+)/
const HEADER_PACKAGE = /Window\{\S+ u\d+ ([A-Za-z]\w*(?:\.\w+)+)\//
// Android 11+: "Frames: parent=… display=… frame=[0,0][1080,2400] …"; older: "mFrame=[0,0][1080,2400]".
const FRAME = /(?:^|\s)m?[Ff]rame=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/

/**
 * `dumpsys window windows` → the windows in z-order, top-most first (`Window #0` is on top).
 * Each window's package comes from its `package=` line (or its title), its frame from `frame=`.
 */
export function parseWindowLayers(dumpsys: string): WindowLayer[] {
  const layers: WindowLayer[] = []
  let block: string[] = []
  let indent = -1
  const flush = () => {
    if (indent < 0) return
    const text = block.join('\n')
    const frame = FRAME.exec(text)
    layers.push({
      package: LAYER_PACKAGE.exec(text)?.[1] ?? HEADER_PACKAGE.exec(text)?.[1] ?? '',
      ...(frame && { frame: parseBounds(`[${frame[1]},${frame[2]}][${frame[3]},${frame[4]}]`) }),
    })
    block = []
    indent = -1
  }
  for (const line of dumpsys.split('\n')) {
    const header = WINDOW_HEADER.exec(line)
    if (header) {
      flush()
      indent = header[1]?.length ?? 0
      block.push(line)
    } else if (indent >= 0 && line.trim() !== '') {
      // A line indented no deeper than the header ends the window's section.
      if (line.length - line.trimStart().length <= indent) flush()
      else block.push(line)
    }
  }
  flush()
  return layers
}

const sameBounds = (a: WindowRoot['bounds'], b: WindowRoot['bounds']) =>
  a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
const within = (inner: WindowRoot['bounds'], outer: WindowRoot['bounds']) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w &&
  inner.y + inner.h <= outer.y + outer.h
const area = (b: WindowRoot['bounds']) => b.w * b.h

/**
 * The window-manager layer (index into `layers`, 0 = top-most) of each window, or `undefined`
 * when one of them has none. A window matches a layer of its package whose frame equals its
 * bounds, else the smallest frame that contains them, else any unused layer of its package.
 */
export function matchWindowLayers(
  windows: readonly WindowRoot[],
  layers: readonly WindowLayer[],
): number[] | undefined {
  const match: (number | undefined)[] = windows.map(() => undefined)
  const used = new Set<number>()
  const passes: ((window: WindowRoot, layer: WindowLayer) => boolean)[] = [
    (w, l) => l.frame !== undefined && sameBounds(l.frame, w.bounds),
    (w, l) => l.frame !== undefined && within(w.bounds, l.frame),
    () => true,
  ]
  for (const fits of passes) {
    windows.forEach((window, i) => {
      if (match[i] !== undefined) return
      let best: number | undefined
      layers.forEach((layer, j) => {
        if (used.has(j) || layer.package !== window.package || !fits(window, layer)) return
        const current = best === undefined ? undefined : layers[best]?.frame
        if (best === undefined || (layer.frame && current && area(layer.frame) < area(current))) {
          best = j
        }
      })
      if (best === undefined) return
      match[i] = best
      used.add(best)
    })
  }
  return match.every((z) => z !== undefined) ? match : undefined
}

const SYSTEM_UI = 'com.android.systemui'
const KEYBOARD = /inputmethod|keyboard|honeyboard|swiftkey/i

/**
 * Indices of `windows`, bottom-most first. u2's dump order means nothing — UiDevice collects the
 * window roots in a HashSet — so the window manager's z-order decides (research R5). Without it
 * (fixtures, a window that just appeared) windows are ordered by class the way Android layers
 * them: full-screen windows at the bottom, smaller ones (dialogs, popups) above, then the
 * keyboard, then system UI on top.
 */
export function windowOrder(
  windows: readonly WindowRoot[],
  layers?: readonly WindowLayer[],
): number[] {
  const indices = windows.map((_, i) => i)
  const z = layers && matchWindowLayers(windows, layers)
  if (z) return indices.sort((a, b) => (z[b] ?? 0) - (z[a] ?? 0))
  const rank = (w: WindowRoot) => (w.package === SYSTEM_UI ? 2 : KEYBOARD.test(w.package) ? 1 : 0)
  const key = (i: number) => windows[i] as WindowRoot
  return indices.sort(
    (a, b) => rank(key(a)) - rank(key(b)) || area(key(b).bounds) - area(key(a).bounds) || a - b,
  )
}

/**
 * `dumpWindowHierarchy` XML → top-level windows, bottom-most first (research R3, R5), ordered by
 * `windowOrder` with the window manager's `layers` when the caller has them.
 * `ref` is the index path in the returned list (`0.3.1`).
 */
export function parseHierarchy(xml: string, layers?: readonly WindowLayer[]): ElementNode[] {
  const doc = parser.parse(xml) as { hierarchy?: { node?: RawNode[] } | '' }
  const windows = typeof doc.hierarchy === 'object' ? (doc.hierarchy.node ?? []) : []
  const roots = windows.map((w) => ({ package: w.package ?? '', bounds: parseBounds(w.bounds) }))
  return windowOrder(roots, layers).map((index, i) =>
    toNode(windows[index] as RawNode, String(i), i),
  )
}
