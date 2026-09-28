import { walkTree, type ElementNode, type Permission, type Platform } from '@coral/shared'
import type { DeviceDriver, Point, Size } from '../core/driver'

type NodeSpec = Partial<Omit<ElementNode, 'bounds' | 'children' | 'ref'>> & {
  /** [x, y, w, h] */
  bounds: [number, number, number, number]
  children?: NodeSpec[]
}

/** Builds a node tree for tests; refs are assigned by {@link windows}. */
export function el(spec: NodeSpec): NodeSpec {
  return spec
}

function build(spec: NodeSpec, ref: string, pkg: string): ElementNode {
  const [x, y, w, h] = spec.bounds
  return {
    ref,
    platform_id: spec.platform_id ?? '',
    text: spec.text ?? '',
    desc: spec.desc ?? '',
    class: spec.class ?? 'android.view.View',
    bounds: { x, y, w, h },
    clickable: spec.clickable ?? false,
    enabled: spec.enabled ?? true,
    visible: spec.visible ?? true,
    package_or_bundle: spec.package_or_bundle ?? pkg,
    children: (spec.children ?? []).map((child, i) =>
      build(child, `${ref}.${i}`, spec.package_or_bundle ?? pkg),
    ),
    ...(spec.android ? { android: spec.android } : {}),
  }
}

/** Turns window specs (bottom-most first) into an ElementNode[] with index-path refs. */
export function windows(pkg: string, ...specs: NodeSpec[]): ElementNode[] {
  return specs.map((spec, i) => build(spec, String(i), pkg))
}

export interface FakeScreen {
  /** Successive trees returned by tree(); the last one repeats (simulates animations). */
  frames: ElementNode[][]
  /** Next screen after tapping a node whose platform_id, text or desc is the key. */
  taps?: Record<string, string>
  /** Next screen after back(). */
  back?: string
}

export type FakeCall =
  | { kind: 'tap' | 'longPress'; point: Point; node?: ElementNode; ms?: number }
  | { kind: 'type'; text: string }
  | { kind: 'clearText' | 'back' | 'hideKeyboard' | 'screenshot' }
  | { kind: 'swipe'; from: Point; to: Point; ms: number }
  | { kind: 'launch' | 'resetApp' | 'isAppRunning'; appId: string }
  | { kind: 'openDeepLink'; url: string }
  | { kind: 'install'; path: string; sha256: string }
  | { kind: 'grantPermissions'; appId: string; permissions: readonly Permission[] }

export interface FakeDriverOptions {
  screens: Record<string, FakeScreen>
  /** Screen shown after launch(). */
  start: string
  /** Screen before launch() (defaults to start). */
  initial?: string
  platform?: Platform
  size?: Size
  logs?: string
}

/**
 * Scripted in-memory device for unit tests of the runner core (no adb, no emulator).
 * Taps hit the deepest visible node that contains the point, searching windows top-most first.
 */
export class FakeDriver implements DeviceDriver {
  readonly platform: Platform
  readonly calls: FakeCall[] = []
  current: string
  appRunning = false
  /** Text typed into each element ref (after clearText). */
  readonly typed = new Map<string, string>()
  private frameIndex = 0
  private focusedRef: string | undefined

  constructor(private readonly options: FakeDriverOptions) {
    this.platform = options.platform ?? 'android'
    this.current = options.initial ?? options.start
  }

  /** Switches to another screen, e.g. to inject a popup between two steps. */
  show(screen: string): void {
    if (!this.options.screens[screen]) throw new Error(`unknown fake screen "${screen}"`)
    this.current = screen
    this.frameIndex = 0
  }

  private screen(): FakeScreen {
    const screen = this.options.screens[this.current]
    if (!screen) throw new Error(`unknown fake screen "${this.current}"`)
    return screen
  }

  private currentTree(): ElementNode[] {
    const { frames } = this.screen()
    return frames[Math.min(this.frameIndex, frames.length - 1)] ?? []
  }

  private hit(point: Point): ElementNode | undefined {
    const inside = (n: ElementNode) =>
      n.visible &&
      point.x >= n.bounds.x &&
      point.x < n.bounds.x + n.bounds.w &&
      point.y >= n.bounds.y &&
      point.y < n.bounds.y + n.bounds.h
    const topFirst = [...this.currentTree()].reverse()
    for (const window of topFirst) {
      const hits = [...walkTree([window])].filter(inside)
      if (hits.length > 0) return hits[hits.length - 1]
    }
    return undefined
  }

  private follow(node: ElementNode | undefined): void {
    const taps = this.screen().taps ?? {}
    for (let n: ElementNode | undefined = node; n; n = this.parent(n)) {
      const next = taps[n.platform_id] ?? taps[n.text] ?? taps[n.desc]
      if (next) {
        this.show(next)
        return
      }
    }
  }

  private parent(node: ElementNode): ElementNode | undefined {
    const parentRef = node.ref.includes('.') ? node.ref.slice(0, node.ref.lastIndexOf('.')) : null
    if (parentRef === null) return undefined
    return [...walkTree(this.currentTree())].find((n) => n.ref === parentRef)
  }

  windowSize(): Promise<Size> {
    return Promise.resolve(this.options.size ?? { width: 1080, height: 2400 })
  }

  screenshot(): Promise<Uint8Array> {
    this.calls.push({ kind: 'screenshot' })
    // PNG signature + screen name: enough for artifact plumbing tests.
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    return Promise.resolve(Uint8Array.from([...png, ...Buffer.from(this.current)]))
  }

  tree(): Promise<ElementNode[]> {
    const tree = this.currentTree()
    this.frameIndex += 1
    return Promise.resolve(tree)
  }

  tapAt(point: Point): Promise<void> {
    const node = this.hit(point)
    this.calls.push({ kind: 'tap', point, ...(node ? { node } : {}) })
    this.focusedRef = node?.ref
    this.follow(node)
    return Promise.resolve()
  }

  longPressAt(point: Point, ms: number): Promise<void> {
    const node = this.hit(point)
    this.calls.push({ kind: 'longPress', point, ms, ...(node ? { node } : {}) })
    this.follow(node)
    return Promise.resolve()
  }

  type(text: string): Promise<void> {
    this.calls.push({ kind: 'type', text })
    if (this.focusedRef)
      this.typed.set(this.focusedRef, (this.typed.get(this.focusedRef) ?? '') + text)
    return Promise.resolve()
  }

  clearText(): Promise<void> {
    this.calls.push({ kind: 'clearText' })
    if (this.focusedRef) this.typed.set(this.focusedRef, '')
    return Promise.resolve()
  }

  swipe(from: Point, to: Point, ms: number): Promise<void> {
    this.calls.push({ kind: 'swipe', from, to, ms })
    return Promise.resolve()
  }

  back(): Promise<void> {
    this.calls.push({ kind: 'back' })
    const next = this.screen().back
    if (next) this.show(next)
    return Promise.resolve()
  }

  hideKeyboard(): Promise<void> {
    this.calls.push({ kind: 'hideKeyboard' })
    return Promise.resolve()
  }

  launch(appId: string): Promise<void> {
    this.calls.push({ kind: 'launch', appId })
    this.appRunning = true
    this.show(this.options.start)
    return Promise.resolve()
  }

  openDeepLink(url: string): Promise<void> {
    this.calls.push({ kind: 'openDeepLink', url })
    return Promise.resolve()
  }

  install(path: string, sha256: string): Promise<void> {
    this.calls.push({ kind: 'install', path, sha256 })
    return Promise.resolve()
  }

  resetApp(appId: string): Promise<void> {
    this.calls.push({ kind: 'resetApp', appId })
    this.appRunning = false
    return Promise.resolve()
  }

  grantPermissions(appId: string, permissions: readonly Permission[]): Promise<void> {
    this.calls.push({ kind: 'grantPermissions', appId, permissions })
    return Promise.resolve()
  }

  isAppRunning(appId: string): Promise<boolean> {
    this.calls.push({ kind: 'isAppRunning', appId })
    return Promise.resolve(this.appRunning)
  }

  deviceLogs(): Promise<string> {
    return Promise.resolve(this.options.logs ?? '')
  }
}
