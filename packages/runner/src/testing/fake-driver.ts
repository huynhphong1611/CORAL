import { walkTree, type ElementNode, type Permission, type Platform } from '@coral/shared'
import type {
  DeviceDriver,
  ForegroundActivity,
  FrameOptions,
  FrameSource,
  LiveFrame,
  Point,
  RemoteControl,
  Size,
} from '../core/driver'
import { imageInfo } from '../core/image/size'
import { renderTree, type RenderOptions } from './render'

type NodeSpec = Partial<Omit<ElementNode, 'bounds' | 'children' | 'ref'>> & {
  /** [x, y, w, h] */
  bounds: [number, number, number, number]
  children?: NodeSpec[]
}

/** Builds a node tree for tests; refs are assigned by {@link windows}. */
const NO_ANDROID_FLAGS: NonNullable<ElementNode['android']> = {
  password: false,
  focused: false,
  scrollable: false,
  drawing_order: 0,
  window_index: 0,
}

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
  /**
   * A tap of this key (as in `taps`) goes to its `taps` screen only when the field typed into on
   * this screen holds `equals`; otherwise to `otherwise` (a code to verify).
   */
  checks?: Record<string, { field: string; equals: string; otherwise: string }>
}

export type FakeCall =
  | { kind: 'tap' | 'longPress'; point: Point; node?: ElementNode; ms?: number }
  | { kind: 'type'; text: string }
  | { kind: 'clearText' | 'back' | 'hideKeyboard' | 'screenshot' | 'home' }
  | { kind: 'swipe'; from: Point; to: Point; ms: number }
  | { kind: 'launch' | 'resetApp' | 'isAppRunning' | 'stopApp'; appId: string }
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
  /** screenshot() draws the current tree (renderTree) instead of returning a stub PNG. */
  renderScreens?: boolean | RenderOptions
  /**
   * Typed text shows up as the text of the field it went into, and the tapped field is marked
   * focused, as in a u2 dump (live view, Recorder).
   */
  showTyped?: boolean
}

/**
 * Scripted in-memory device for unit tests of the runner core (no adb, no emulator).
 * Taps hit the deepest visible node that contains the point, searching windows top-most first.
 */
export class FakeDriver implements DeviceDriver, FrameSource, RemoteControl {
  readonly platform: Platform
  readonly calls: FakeCall[] = []
  current: string
  appRunning = false
  /** Text typed into each element ref (after clearText). */
  readonly typed = new Map<string, string>()
  /** Screen of each typed ref: refs are index paths, the same one exists on other screens. */
  private readonly typedOn = new Map<string, string>()
  private frameIndex = 0
  private focused: { ref: string; screen: string } | undefined
  private rendered: { tree: ElementNode[]; png: Uint8Array } | undefined

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
    const tree = frames[Math.min(this.frameIndex, frames.length - 1)] ?? []
    return this.options.showTyped ? this.withTyped(tree) : tree
  }

  private typedView: { tree: ElementNode[]; key: string; view: ElementNode[] } | undefined

  /**
   * The tree with typed text written into its fields and the focused field marked (same object
   * while nothing changes).
   */
  private withTyped(tree: ElementNode[]): ElementNode[] {
    const focused = this.focusedHere()
    if (this.typed.size === 0 && focused === undefined) return tree
    const key = JSON.stringify([this.current, focused, ...this.typed])
    if (this.typedView?.tree === tree && this.typedView.key === key) return this.typedView.view
    const fill = (node: ElementNode): ElementNode => ({
      ...node,
      text:
        (this.typedOn.get(node.ref) === this.current ? this.typed.get(node.ref) : undefined) ??
        node.text,
      // Only fields take the focus on a device.
      ...(node.ref === focused && /EditText$/.test(node.class)
        ? { android: { ...(node.android ?? NO_ANDROID_FLAGS), focused: true } }
        : {}),
      children: node.children.map(fill),
    })
    const view = tree.map(fill)
    this.typedView = { tree, key, view }
    return view
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
    const { taps = {}, checks = {} } = this.screen()
    for (let n: ElementNode | undefined = node; n; n = this.parent(n)) {
      const key = [n.platform_id, n.text, n.desc].find((k) => k && taps[k] !== undefined)
      if (key === undefined) continue
      const check = checks[key]
      const next = taps[key] ?? ''
      this.show(check && this.typedIn(check.field) !== check.equals ? check.otherwise : next)
      return
    }
  }

  /** What was typed into the field with this platform id on the current screen. */
  private typedIn(platformId: string): string | undefined {
    const field = [...walkTree(this.screen().frames.at(-1) ?? [])].find(
      (n) => n.platform_id === platformId,
    )
    if (!field || this.typedOn.get(field.ref) !== this.current) return undefined
    return this.typed.get(field.ref)
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
    if (this.options.renderScreens) return Promise.resolve(this.render())
    // PNG signature + screen name: enough for artifact plumbing tests.
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    return Promise.resolve(Uint8Array.from([...png, ...Buffer.from(this.current)]))
  }

  /** The current tree drawn as a PNG, redrawn only when the tree changes. */
  private render(): Uint8Array {
    const tree = this.currentTree()
    if (this.rendered?.tree !== tree) {
      const options =
        typeof this.options.renderScreens === 'object' ? this.options.renderScreens : {}
      const size = this.options.size ?? { width: 1080, height: 2400 }
      this.rendered = { tree, png: renderTree(tree, size, options) }
    }
    return this.rendered.png
  }

  /**
   * The current screen drawn by renderTree, as a PNG at the `renderScreens` scale (`maxEdge` and
   * `quality` are ignored). Not recorded in `calls`: the live view reads, it does not act.
   */
  streamFrame(_options: FrameOptions): Promise<LiveFrame> {
    const image = this.render()
    const info = imageInfo(image)
    const size = this.options.size ?? { width: 1080, height: 2400 }
    return Promise.resolve({
      image,
      mime: 'image/png',
      width: info?.width ?? size.width,
      height: info?.height ?? size.height,
      deviceWidth: size.width,
      deviceHeight: size.height,
      rotation: 0,
    })
  }

  tree(): Promise<ElementNode[]> {
    const tree = this.currentTree()
    this.frameIndex += 1
    return Promise.resolve(tree)
  }

  tapAt(point: Point): Promise<void> {
    const node = this.hit(point)
    this.calls.push({ kind: 'tap', point, ...(node ? { node } : {}) })
    this.focused = node ? { ref: node.ref, screen: this.current } : undefined
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
    const ref = this.focusedHere()
    // Refs are index paths: text typed on another screen is not in this field.
    const before = ref && this.typedOn.get(ref) === this.current ? this.typed.get(ref) : undefined
    if (ref) this.typedInto(ref, (before ?? '') + text)
    return Promise.resolve()
  }

  clearText(): Promise<void> {
    this.calls.push({ kind: 'clearText' })
    const ref = this.focusedHere()
    if (ref) this.typedInto(ref, '')
    return Promise.resolve()
  }

  /** The focused field when it is still on screen (a tap that changed screens leaves no focus). */
  private focusedHere(): string | undefined {
    return this.focused?.screen === this.current ? this.focused.ref : undefined
  }

  private typedInto(ref: string, text: string): void {
    this.typed.set(ref, text)
    this.typedOn.set(ref, this.current)
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

  /** Leaves the app (the fake has no launcher: the screen stays, the app is not running). */
  home(): Promise<void> {
    this.calls.push({ kind: 'home' })
    this.appRunning = false
    return Promise.resolve()
  }

  stopApp(appId: string): Promise<void> {
    this.calls.push({ kind: 'stopApp', appId })
    this.appRunning = false
    return Promise.resolve()
  }

  /** Starts the app afresh: its first screen, the fields empty (text typed before is gone). */
  launch(appId: string): Promise<void> {
    this.calls.push({ kind: 'launch', appId })
    this.appRunning = true
    this.typed.clear()
    this.typedOn.clear()
    this.focused = undefined
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
    if (this.options.showTyped) {
      this.typed.clear()
      this.typedOn.clear()
    }
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

  /** The app window's package and the fake screen's name as its activity (`.catalog`). */
  foregroundActivity(): Promise<ForegroundActivity | undefined> {
    const app = this.currentTree().find((window) => !SYSTEM_PACKAGES.test(window.package_or_bundle))
    return Promise.resolve(
      app ? { package: app.package_or_bundle, activity: `.${this.current}` } : undefined,
    )
  }
}

/** Windows that are never the app's own (status bar, keyboards, permission dialogs). */
const SYSTEM_PACKAGES =
  /^(com\.android\.systemui|android)$|inputmethod|\.ime$|keyboard|permissioncontroller/i
