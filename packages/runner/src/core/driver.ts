import type { ElementNode, Permission, Platform } from '@coral/shared'

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

/**
 * Platform-neutral UI control (SPEC §8.1, D28). The runner core only talks to this interface and
 * to TargetLifecycle. Coordinates are in the platform's tap unit (px on Android, pt on iOS).
 * Element lookup is not part of the driver: the core resolver searches `tree()` (research R4).
 */
export interface UiDriver {
  readonly platform: Platform
  windowSize(): Promise<Size>
  /** PNG, in pixels. */
  screenshot(): Promise<Uint8Array>
  /** Top-level windows of the current screen, bottom-most first (research R5). */
  tree(): Promise<ElementNode[]>
  tapAt(point: Point): Promise<void>
  longPressAt(point: Point, ms: number): Promise<void>
  /** Types into the focused element (the core taps the target first). Must support Unicode. */
  type(text: string): Promise<void>
  /** Clears the focused text field. */
  clearText(): Promise<void>
  swipe(from: Point, to: Point, ms: number): Promise<void>
  back(): Promise<void>
  hideKeyboard(): Promise<void>
}

/** What differs per kind of target (mobile device today; browser if web testing is added — §20 Q4). */
export interface TargetLifecycle {
  launch(appId: string): Promise<void>
  openDeepLink(url: string): Promise<void>
  install(buildPath: string, sha256: string): Promise<void>
  resetApp(appId: string): Promise<void>
  grantPermissions(appId: string, permissions: readonly Permission[]): Promise<void>
  isAppRunning(appId: string): Promise<boolean>
  /** Device log since `sinceMs` (epoch ms): logcat on Android. */
  deviceLogs(sinceMs: number): Promise<string>
}

export interface DeviceDriver extends UiDriver, TargetLifecycle {}
