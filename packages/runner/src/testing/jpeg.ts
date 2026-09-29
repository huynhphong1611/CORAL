/**
 * The header of a baseline JPEG of the given size (SOI, JFIF APP0, SOF0, EOI) — enough for code
 * that only reads image sizes; `progressive` writes SOF2 instead.
 */
export function jpegHeader(width: number, height: number, progressive = false): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]
  const sof = [
    0xff,
    progressive ? 0xc2 : 0xc0,
    0x00,
    0x11,
    8,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ]
  return Uint8Array.from([0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9])
}
