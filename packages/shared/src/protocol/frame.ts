import { z } from 'zod'

/** Largest binary frame (header + image) on either WebSocket (contracts/agent-ws-phase2.md). */
export const MAX_FRAME_BYTES = 2 * 1024 * 1024
const MAX_HEADER_BYTES = 4096

const px = z.number().int().positive()

/**
 * Header of a live-view frame (research R5). The agent names the device by `udid`; the server
 * forwards it to browsers under `device_id`. `width`/`height` are the image's size,
 * `device_width`/`device_height` the screen's in device pixels (for coordinate mapping), and
 * `rotation` the display rotation in degrees.
 */
export const frameHeaderSchema = z
  .object({
    type: z.literal('stream.frame'),
    udid: z.string().min(1).optional(),
    device_id: z.uuid().optional(),
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    width: px,
    height: px,
    device_width: px,
    device_height: px,
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    mime: z.enum(['image/jpeg', 'image/png']),
  })
  .refine((h) => (h.udid === undefined) !== (h.device_id === undefined), {
    message: 'a frame names its device by exactly one of udid or device_id',
  })
export type FrameHeader = z.infer<typeof frameHeaderSchema>

export interface Frame {
  header: FrameHeader
  image: Uint8Array
}

export type FrameDecodeResult =
  | { ok: true; frame: Frame }
  | { ok: false; code: 'frame_too_large' | 'invalid_frame'; message: string }

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

/** `[uint32 BE header length][header JSON, UTF-8][image bytes]` — runs in Node and browsers. */
export function encodeFrame(header: FrameHeader, image: Uint8Array): Uint8Array {
  const json = encoder.encode(JSON.stringify(frameHeaderSchema.parse(header)))
  const out = new Uint8Array(4 + json.length + image.length)
  if (out.length > MAX_FRAME_BYTES) {
    throw new RangeError(`frame of ${out.length} bytes exceeds ${MAX_FRAME_BYTES}`)
  }
  new DataView(out.buffer).setUint32(0, json.length, false)
  out.set(json, 4)
  out.set(image, 4 + json.length)
  return out
}

/** Parses a binary frame; a malformed one is reported, never thrown (FR-025: it is dropped). */
export function decodeFrame(data: Uint8Array | ArrayBuffer): FrameDecodeResult {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (bytes.length > MAX_FRAME_BYTES) {
    return { ok: false, code: 'frame_too_large', message: `${bytes.length} bytes` }
  }
  if (bytes.length < 4) return { ok: false, code: 'invalid_frame', message: 'shorter than 4 bytes' }
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false)
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES || 4 + headerLength > bytes.length) {
    return { ok: false, code: 'invalid_frame', message: `bad header length ${headerLength}` }
  }
  let raw: unknown
  try {
    raw = JSON.parse(decoder.decode(bytes.subarray(4, 4 + headerLength)))
  } catch {
    return { ok: false, code: 'invalid_frame', message: 'header is not UTF-8 JSON' }
  }
  const header = frameHeaderSchema.safeParse(raw)
  if (!header.success) {
    return { ok: false, code: 'invalid_frame', message: z.prettifyError(header.error) }
  }
  const image = bytes.subarray(4 + headerLength)
  if (image.length === 0) return { ok: false, code: 'invalid_frame', message: 'no image bytes' }
  return { ok: true, frame: { header: header.data, image } }
}
