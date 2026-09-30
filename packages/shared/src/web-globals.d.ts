// The only platform APIs this package uses: web standards that Node and browsers both provide
// (tsconfig keeps Node and DOM globals out). Other packages get them from @types/node or DOM.
declare global {
  class TextEncoder {
    encode(input?: string): Uint8Array
  }
  class TextDecoder {
    constructor(label?: string, options?: { fatal?: boolean })
    decode(input?: Uint8Array): string
  }
}

export {}
