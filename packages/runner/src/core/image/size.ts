/** Size and type of an encoded image, read from its header (no decoding). */
export interface ImageInfo {
  mime: 'image/png' | 'image/jpeg'
  width: number
  height: number
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// Start-of-frame markers carry the size; C4 (DHT), C8 (JPG) and CC (DAC) are not frames.
const isStartOfFrame = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc

/** PNG (IHDR) or JPEG (first SOFn segment); undefined for anything else or a cut-off file. */
export function imageInfo(bytes: Uint8Array): ImageInfo | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length >= 24 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    return { mime: 'image/png', width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  let at = 2
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return undefined
    const marker = bytes[at + 1] ?? 0
    // Fill bytes and markers without a length (RSTn, TEM).
    if (marker === 0xff) {
      at += 1
      continue
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2
      continue
    }
    const length = view.getUint16(at + 2)
    if (isStartOfFrame(marker)) {
      if (at + 9 > bytes.length) return undefined
      return { mime: 'image/jpeg', height: view.getUint16(at + 5), width: view.getUint16(at + 7) }
    }
    at += 2 + length
  }
  return undefined
}
