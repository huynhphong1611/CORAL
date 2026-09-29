import { walkTree, type ElementNode } from '@coral/shared'
import { encode } from 'fast-png'
import type { Size } from '../core/driver'
import { glyph } from './font5x7'

type Rgb = readonly [number, number, number]

const COLORS = {
  app: [250, 250, 250],
  appText: [32, 33, 36],
  clickable: [232, 240, 254],
  border: [25, 103, 210],
  field: [255, 255, 255],
  fieldBorder: [128, 134, 139],
  status: [32, 33, 36],
  statusText: [255, 255, 255],
  keyboard: [232, 234, 237],
  dialog: [255, 255, 255],
  dialogBorder: [95, 99, 104],
  dialogButton: [210, 227, 252],
} as const satisfies Record<string, Rgb>

const SYSTEM_UI = 'com.android.systemui'
const KEYBOARD = /inputmethod|keyboard/i

class Canvas {
  readonly data: Uint8Array
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8Array(width * height * 3)
  }

  /** Fills a rectangle, optionally blending with what is there (alpha 0–1). */
  fill(x: number, y: number, w: number, h: number, color: Rgb, alpha = 1): void {
    const x0 = Math.max(0, Math.round(x))
    const y0 = Math.max(0, Math.round(y))
    const x1 = Math.min(this.width, Math.round(x + w))
    const y1 = Math.min(this.height, Math.round(y + h))
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        const i = (py * this.width + px) * 3
        for (let c = 0; c < 3; c += 1) {
          const value = color[c] ?? 0
          this.data[i + c] =
            alpha >= 1 ? value : Math.round((this.data[i + c] ?? 0) * (1 - alpha) + value * alpha)
        }
      }
    }
  }

  frame(x: number, y: number, w: number, h: number, color: Rgb, thickness: number): void {
    this.fill(x, y, w, thickness, color)
    this.fill(x, y + h - thickness, w, thickness, color)
    this.fill(x, y, thickness, h, color)
    this.fill(x + w - thickness, y, thickness, h, color)
  }

  /** Draws ASCII text with the 5×8 font, `scale` pixels per font pixel, clipped to `maxWidth`. */
  text(x: number, y: number, text: string, color: Rgb, scale: number, maxWidth: number): void {
    const advance = 6 * scale
    const fits = Math.max(0, Math.floor(maxWidth / advance))
    const shown = text.length > fits ? `${text.slice(0, Math.max(0, fits - 1))}~` : text
    ;[...shown].forEach((char, n) => {
      glyph(char).forEach((column, cx) => {
        for (let cy = 0; cy < 8; cy += 1) {
          if (column & (1 << cy))
            this.fill(x + n * advance + cx * scale, y + cy * scale, scale, scale, color)
        }
      })
    })
  }
}

/** Vietnamese and other accented letters lose their marks; anything else non-ASCII becomes "?". */
function ascii(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, (c) => (c === 'đ' ? 'd' : 'D'))
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^\x20-\x7e]/g, '?')
}

export interface RenderOptions {
  /** Output size relative to the device screen (0.5 → half width and height). */
  scale?: number
}

/**
 * Draws an element tree (bottom-most window first) as a PNG, the way a device would roughly show
 * it: app background, clickable nodes as outlined boxes, fields, texts, the status bar, the
 * keyboard, and dialogs over a dimmed screen. For FakeDriver screenshots, live-view demos and E2E.
 */
export function renderTree(
  tree: readonly ElementNode[],
  size: Size,
  options: RenderOptions = {},
): Uint8Array {
  const scale = options.scale ?? 1
  const width = Math.max(1, Math.round(size.width * scale))
  const height = Math.max(1, Math.round(size.height * scale))
  const canvas = new Canvas(width, height)
  const s = (v: number) => v * scale
  const fontScale = Math.max(1, Math.round(4 * scale))
  canvas.fill(0, 0, width, height, COLORS.app)
  const base = tree[0]?.package_or_bundle

  tree.forEach((window, index) => {
    if (!window.visible) return
    const { x, y, w, h } = window.bounds
    const isStatus = window.package_or_bundle === SYSTEM_UI
    const isKeyboard = KEYBOARD.test(window.package_or_bundle)
    const isDialog =
      index > 0 &&
      !isStatus &&
      !isKeyboard &&
      (window.package_or_bundle !== base || w * h < size.width * size.height)
    if (isDialog) canvas.fill(0, 0, width, height, [0, 0, 0], 0.4)
    const background = isStatus
      ? COLORS.status
      : isKeyboard
        ? COLORS.keyboard
        : isDialog
          ? COLORS.dialog
          : COLORS.app
    canvas.fill(s(x), s(y), s(w), s(h), background)
    if (isDialog)
      canvas.frame(s(x), s(y), s(w), s(h), COLORS.dialogBorder, Math.max(1, Math.round(s(3))))
    const ink = isStatus ? COLORS.statusText : COLORS.appText

    for (const node of walkTree([window])) {
      if (!node.visible || node === window) continue
      const b = node.bounds
      const isField = /EditText/.test(node.class)
      if (isField) {
        canvas.fill(s(b.x), s(b.y), s(b.w), s(b.h), COLORS.field)
        canvas.frame(
          s(b.x),
          s(b.y),
          s(b.w),
          s(b.h),
          COLORS.fieldBorder,
          Math.max(1, Math.round(s(2))),
        )
      } else if (node.clickable) {
        canvas.fill(
          s(b.x),
          s(b.y),
          s(b.w),
          s(b.h),
          isDialog ? COLORS.dialogButton : COLORS.clickable,
        )
        canvas.frame(s(b.x), s(b.y), s(b.w), s(b.h), COLORS.border, Math.max(1, Math.round(s(2))))
      }
      const raw =
        node.android?.password && node.text
          ? '*'.repeat(node.text.length)
          : node.text || (node.clickable ? node.desc : '')
      if (!raw) continue
      const label = ascii(raw)
      const textHeight = 8 * fontScale
      canvas.text(
        s(b.x) + Math.max(2, s(16)),
        s(b.y) + Math.max(0, (s(b.h) - textHeight) / 2),
        label,
        ink,
        fontScale,
        s(b.w) - Math.max(4, s(32)),
      )
    }
  })
  return encode({ width, height, data: canvas.data, channels: 3, depth: 8 })
}
