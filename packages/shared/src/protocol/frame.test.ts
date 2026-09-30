import { describe, expect, it } from 'vitest'
import { MAX_FRAME_BYTES, decodeFrame, encodeFrame, type FrameHeader } from './frame'

const header: FrameHeader = {
  type: 'stream.frame',
  udid: 'emulator-5554',
  seq: 7,
  ts: 1_700_000_000_000,
  width: 540,
  height: 1200,
  device_width: 1080,
  device_height: 2400,
  rotation: 0,
  mime: 'image/jpeg',
}
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9])

function withHeaderBytes(json: string, image = jpeg): Uint8Array {
  const body = new TextEncoder().encode(json)
  const out = new Uint8Array(4 + body.length + image.length)
  new DataView(out.buffer).setUint32(0, body.length)
  out.set(body, 4)
  out.set(image, 4 + body.length)
  return out
}

describe('binary frames (research R5)', () => {
  it('round-trips header and image, from a Uint8Array or an ArrayBuffer', () => {
    const bytes = encodeFrame(header, jpeg)
    expect(new DataView(bytes.buffer).getUint32(0, false)).toBe(bytes.length - 4 - jpeg.length)
    for (const input of [bytes, bytes.slice().buffer]) {
      const decoded = decodeFrame(input)
      expect(decoded).toEqual({ ok: true, frame: { header, image: jpeg } })
    }
  })

  it('decodes a frame that sits inside a larger buffer (ws hands out such views)', () => {
    const bytes = encodeFrame(
      { ...header, udid: undefined, device_id: '01890a5d-ac96-774b-bcce-b302099a8057' },
      jpeg,
    )
    const padded = new Uint8Array(bytes.length + 10)
    padded.set(bytes, 5)
    const decoded = decodeFrame(padded.subarray(5, 5 + bytes.length))
    expect(decoded.ok && decoded.frame.header.device_id).toBe(
      '01890a5d-ac96-774b-bcce-b302099a8057',
    )
  })

  it('reports malformed frames instead of throwing', () => {
    const cases: [string, Uint8Array][] = [
      ['too short', new Uint8Array([0, 0])],
      ['length past the end', withHeaderBytes('{}').subarray(0, 6)],
      ['not JSON', withHeaderBytes('{nope')],
      [
        'not UTF-8',
        (() => {
          const b = withHeaderBytes('{"a":1}')
          b[5] = 0xff
          return b
        })(),
      ],
      ['bad header', withHeaderBytes(JSON.stringify({ ...header, mime: 'image/gif' }))],
      ['no device', withHeaderBytes(JSON.stringify({ ...header, udid: undefined }))],
      [
        'two devices',
        withHeaderBytes(
          JSON.stringify({ ...header, device_id: '01890a5d-ac96-774b-bcce-b302099a8057' }),
        ),
      ],
      ['no image', withHeaderBytes(JSON.stringify(header), new Uint8Array())],
    ]
    for (const [name, bytes] of cases) {
      const decoded = decodeFrame(bytes)
      expect(decoded.ok, name).toBe(false)
      expect(!decoded.ok && decoded.code, name).toBe('invalid_frame')
    }
  })

  it('refuses frames over 2 MB on both ends', () => {
    const big = new Uint8Array(MAX_FRAME_BYTES)
    expect(() => encodeFrame(header, big)).toThrow(RangeError)
    const decoded = decodeFrame(new Uint8Array(MAX_FRAME_BYTES + 1))
    expect(!decoded.ok && decoded.code).toBe('frame_too_large')
  })

  it('validates the header when encoding', () => {
    expect(() => encodeFrame({ ...header, width: 0 }, jpeg)).toThrow()
  })
})
