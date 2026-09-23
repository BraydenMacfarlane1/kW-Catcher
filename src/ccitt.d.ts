export interface CcittSource {
  next(): number;
}

export interface CcittOptions {
  K?: number;
  EndOfLine?: boolean;
  EncodedByteAlign?: boolean;
  Columns?: number;
  Rows?: number;
  EndOfBlock?: boolean;
  BlackIs1?: boolean;
}

/** Pure-JS CCITT fax decoder (pdf.js / Xpdf, Apache-2.0). See src/ccitt.js. */
export class CCITTFaxDecoder {
  constructor(source: CcittSource, options?: CcittOptions);
  readNextChar(): number;
}
