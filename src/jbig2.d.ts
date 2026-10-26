export interface Jbig2Chunk {
  data: Uint8Array;
  start: number;
  end: number;
}

/** Pure-JS JBIG2 decoder (pdf.js v4.10.38, Apache-2.0). See src/jbig2.js. */
export class Jbig2Image {
  /** Packed 1-bit rows, MSB first, 1 = black. Globals chunk first, then the image stream. */
  parseChunks(chunks: Jbig2Chunk[]): Uint8Array;
}

export class Jbig2Error extends Error {}
