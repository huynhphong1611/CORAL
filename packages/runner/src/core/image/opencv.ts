import { createRequire } from 'node:module'
import { toGrey, type ImageMatcher, type Match, type MatchOptions } from './matcher'
import { decodeToRgb, type RgbImage } from './png'

// The part of OpenCV.js this matcher uses (the package's own typings are generated for the whole
// library and do not describe the runtime object's loading states).
interface CvMat {
  readonly rows: number
  readonly cols: number
  readonly data: Uint8Array
  roi(rect: unknown): CvMat
  delete(): void
}
interface OpenCv {
  Mat: new (rows?: number, cols?: number, type?: number) => CvMat
  Size: new (width: number, height: number) => unknown
  Rect: new (x: number, y: number, width: number, height: number) => unknown
  CV_8UC1: number
  INTER_AREA: number
  INTER_LINEAR: number
  TM_CCOEFF_NORMED: number
  resize(src: CvMat, dst: CvMat, size: unknown, fx: number, fy: number, interpolation: number): void
  matchTemplate(image: CvMat, template: CvMat, result: CvMat, method: number): void
  minMaxLoc(src: CvMat): { maxVal: number; maxLoc: { x: number; y: number } }
}
type Loading = OpenCv & { onRuntimeInitialized?: () => void }

const require = createRequire(import.meta.url)
let loaded: Promise<{ cv: OpenCv }> | undefined

/**
 * OpenCV.js (WASM, ~9 MB), loaded on first use only: a run without image locators never pays for
 * it (research R12). The Emscripten module has a `then` of its own, so it is never awaited or used
 * to resolve a promise (that would call it): it travels wrapped in `{ cv }`.
 */
export function loadOpenCv(): Promise<{ cv: OpenCv }> {
  loaded ??= new Promise<{ cv: OpenCv }>((resolve, reject) => {
    // CommonJS on purpose: an ESM namespace of this package gets a `then` copied onto it.
    const exported = require('@techstark/opencv-js') as Promise<Loading> | Loading
    if (exported instanceof Promise) {
      exported.then((cv) => resolve({ cv }), reject)
    } else if (typeof exported.matchTemplate === 'function') {
      resolve({ cv: exported })
    } else {
      exported.onRuntimeInitialized = () => resolve({ cv: exported })
    }
  })
  return loaded
}

function greyMat(cv: OpenCv, image: RgbImage): CvMat {
  const mat = new cv.Mat(image.height, image.width, cv.CV_8UC1)
  mat.data.set(toGrey(image))
  return mat
}

/** Below this spread of grey levels an image has nothing to match on (a flat colour). */
const MIN_SPREAD = 2
/** The border cut off for the content check: 10 % of each side, 1–16 px. */
const INSET_SHARE = 0.1
const INSET_MAX = 16
/** The content may sit this many pixels off the whole template's place (rounding, scaling). */
const SLACK = 2

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Standard deviation of the grey levels of `grey` (row width `width`) inside `rect`. */
export function spread(grey: Uint8Array, width: number, rect: Rect): number {
  let sum = 0
  let squares = 0
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const v = grey[y * width + x] ?? 0
      sum += v
      squares += v * v
    }
  }
  const n = rect.w * rect.h
  return n === 0 ? 0 : Math.sqrt(Math.max(0, squares / n - (sum / n) ** 2))
}

/** The template without its edges (borders, rounded corners); undefined when too small. */
export function contentRect(width: number, height: number): Rect | undefined {
  const inset = (size: number) => Math.min(INSET_MAX, Math.max(1, Math.round(size * INSET_SHARE)))
  const x = inset(width)
  const y = inset(height)
  if (width - 2 * x < 4 || height - 2 * y < 4) return undefined
  return { x, y, w: width - 2 * x, h: height - 2 * y }
}

/**
 * Template matching with OpenCV (D27, research R12): both images in grey, the template resized
 * once by `scale`, normalised correlation (`TM_CCOEFF_NORMED`) over the whole screen for the best
 * place. There, the template's content (its edges cut off) is matched again: elements of one
 * style share borders and background, which would make any same-style button look alike, so the
 * score is the lower of the two and must reach `threshold`. A flat template, or flat content, is
 * never matched: nothing tells one place from another (no blind tap, SC-005).
 */
export function openCvMatcher(): ImageMatcher {
  return {
    async find(screenPng: Uint8Array, templatePng: Uint8Array, options: MatchOptions) {
      const { cv } = await loadOpenCv()
      const mats: CvMat[] = []
      const track = (mat: CvMat) => (mats.push(mat), mat)
      try {
        const screen = track(greyMat(cv, decodeToRgb(screenPng)))
        let template = track(greyMat(cv, decodeToRgb(templatePng)))
        const scale = options.scale ?? 1
        if (Math.abs(scale - 1) > 1e-3) {
          const width = Math.max(1, Math.round(template.cols * scale))
          const height = Math.max(1, Math.round(template.rows * scale))
          const resized = track(new cv.Mat())
          const shrinking = scale < 1
          cv.resize(
            template,
            resized,
            new cv.Size(width, height),
            0,
            0,
            shrinking ? cv.INTER_AREA : cv.INTER_LINEAR,
          )
          template = resized
        }
        const { cols: w, rows: h } = template
        if (w > screen.cols || h > screen.rows) return undefined
        // A copy: the Mat's bytes live in WASM memory, which may move.
        const grey = template.data.slice()
        if (spread(grey, w, { x: 0, y: 0, w, h }) < MIN_SPREAD) return undefined

        const best = (image: CvMat, part: CvMat) => {
          const result = track(new cv.Mat())
          cv.matchTemplate(image, part, result, cv.TM_CCOEFF_NORMED)
          const { maxVal, maxLoc } = cv.minMaxLoc(result)
          return { score: Number.isFinite(maxVal) ? maxVal : -1, at: maxLoc }
        }
        const whole = best(screen, template)
        if (whole.score < options.threshold) return undefined

        let score = whole.score
        const content = contentRect(w, h)
        if (content) {
          if (spread(grey, w, content) < MIN_SPREAD) return undefined
          const x0 = Math.max(0, whole.at.x + content.x - SLACK)
          const y0 = Math.max(0, whole.at.y + content.y - SLACK)
          const x1 = Math.min(screen.cols, whole.at.x + content.x + content.w + SLACK)
          const y1 = Math.min(screen.rows, whole.at.y + content.y + content.h + SLACK)
          const around = track(screen.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0)))
          const inner = track(template.roi(new cv.Rect(content.x, content.y, content.w, content.h)))
          score = Math.min(score, best(around, inner).score)
        }
        if (score < options.threshold) return undefined
        return { bounds: { x: whole.at.x, y: whole.at.y, w, h }, score } satisfies Match
      } finally {
        for (const mat of mats) mat.delete()
      }
    },
  }
}
