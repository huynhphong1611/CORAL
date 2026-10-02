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
  /**
   * Package whose crash / not-responding dialog has the focus, when the platform can tell
   * (Android: the focused system window's title). Undefined when unknown.
   */
  systemDialogOwner?(): Promise<string | undefined>
  /**
   * The activity in the foreground, when the platform tells (Android `dumpsys activity`): part of
   * a screen's fingerprint (D24). Undefined when unknown.
   */
  foregroundActivity?(): Promise<ForegroundActivity | undefined>
}

export interface ForegroundActivity {
  package: string
  /** `.view.activities.MainActivity` when inside `package`, else the full class name. */
  activity: string
}

export interface DeviceDriver extends UiDriver, TargetLifecycle {}

/** What a person controlling the device from the browser needs beyond the runner (US3). */
export interface RemoteControl {
  /** The Home button. */
  home(): Promise<void>
  /** Stops the app, keeping its data (restart = stop + launch). */
  stopApp(appId: string): Promise<void>
}

export interface FrameOptions {
  /** Longest edge of the image, in pixels (the device may send a smaller one). */
  maxEdge: number
  /** JPEG quality 1–100 (ignored when the device can only send PNG). */
  quality: number
}

/** One live-view frame (research R4): the encoded image and the screen it maps to. */
export interface LiveFrame {
  image: Uint8Array
  mime: 'image/jpeg' | 'image/png'
  width: number
  height: number
  /** Screen size in tap units, current orientation: the browser maps clicks with it (R5). */
  deviceWidth: number
  deviceHeight: number
  rotation: 0 | 90 | 180 | 270
}

/** A driver that can feed the live view (read-only: allowed while a job runs). */
export interface FrameSource {
  streamFrame(options: FrameOptions): Promise<LiveFrame>
}
