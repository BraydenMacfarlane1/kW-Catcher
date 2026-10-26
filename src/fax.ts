import { CCITTFaxDecoder } from "./ccitt.js";
import { Jbig2Image } from "./jbig2.js";
import { orientationOf, type QuarterTurn, type Rgba } from "./orient";

/**
 * Canon MRC scans store sharp text in a CCITT Group 4 image mask and a blurry
 * JPEG underneath. pdf.js in this Worker build only decodes CCITT through a
 * wasm module that is not bundled, so the mask is decoded here in pure JS.
 * Callers rotate the mask when the text was scanned sideways.
 *
 * Bilevel JBIG2 page images (Xerox and other office MFP scans) hit the same gap: pdf.js 5 only
 * decodes JBIG2 through that unbundled wasm module, so extractImages returns nothing and OCR
 * would see blank pages. Those images are decoded here too, with pdf.js 4's pure-JS decoder.
 */
export interface FaxBook {
  readonly pageCount: number;
  pageImage(index: number): Rgba | null;
}

interface PdfObject {
  dict: string;
  bytes: Uint8Array | null;
}

export function openFax(data: Uint8Array): FaxBook | null {
  if (!includesAscii(data, "CCITTFaxDecode") && !includesAscii(data, "JBIG2Decode")) return null;
  const xrefAt = findStartXref(data);
  if (xrefAt == null) return null;
  const xref = parseXref(data, xrefAt);
  if (!xref) return null;
  const rootId = Number(/\/Root\s+(\d+)\s+\d+\s+R/.exec(xref.trailer)?.[1]);
  const root = readObject(data, xref.map, rootId);
  if (!root) return null;
  const pagesId = Number(/\/Pages\s+(\d+)\s+\d+\s+R/.exec(root.dict)?.[1]);
  const pages = collectPages(data, xref.map, pagesId, new Set());
  if (pages.length === 0) return null;
  return {
    pageCount: pages.length,
    pageImage(index: number): Rgba | null {
      const pageId = pages[index];
      if (pageId == null) return null;
      try {
        return decodePageMask(data, xref.map, pageId);
      } catch {
        return null;
      }
    },
  };
}

/** Quarter turn for each fax mask, or null when the PDF has no CCITT text mask. */
export function faxQuarterTurns(data: Uint8Array): Array<QuarterTurn | null> | null {
  const fax = openFax(data);
  if (!fax) return null;
  const turns: Array<QuarterTurn | null> = [];
  for (let index = 0; index < fax.pageCount; index += 1) {
    const image = fax.pageImage(index);
    if (!image) {
      turns.push(null);
      continue;
    }
    const decision = orientationOf(image);
    turns.push("turn" in decision ? decision.turn : null);
  }
  return turns;
}

function decodePageMask(data: Uint8Array, map: Map<number, number>, pageId: number): Rgba | null {
  const page = readObject(data, map, pageId);
  if (!page) return null;
  const body = xobjectBody(data, map, page.dict, 0);
  let best: { bytes: Uint8Array; dict: string; width: number; height: number } | null = null;
  for (const match of body.matchAll(/(\d+)\s+\d+\s+R/g)) {
    const image = readObject(data, map, Number(match[1]));
    if (!image?.bytes || !/CCITTFaxDecode|JBIG2Decode/.test(image.dict)) continue;
    const width = Number(/\/Width\s+(\d+)/.exec(image.dict)?.[1] ?? 0);
    const height = Number(/\/Height\s+(\d+)/.exec(image.dict)?.[1] ?? 0);
    if (!best || width * height > best.width * best.height) best = { bytes: image.bytes, dict: image.dict, width, height };
  }
  if (!best) return null;
  if (best.dict.includes("JBIG2Decode")) return rasterizeJbig2(data, map, best.bytes, best.dict, best.width, best.height);
  return rasterizeMask(best.bytes, best.dict, best.width, best.height);
}

/** JBIG2 page image with optional /JBIG2Globals. Decoded bits are 1 = black; `/Decode [1 0]` flips them. */
function rasterizeJbig2(
  data: Uint8Array,
  map: Map<number, number>,
  raw: Uint8Array,
  dict: string,
  width: number,
  height: number,
): Rgba | null {
  if (width < 8 || height < 8) return null;
  if (/\/Filter\s*\[/.test(dict)) return null; // a filter chain in front of JBIG2 is not handled
  const chunks = [];
  const globalsId = /\/JBIG2Globals\s+(\d+)\s+\d+\s+R/.exec(dict)?.[1];
  if (globalsId) {
    const globals = readObject(data, map, Number(globalsId));
    if (!globals?.bytes || /\/Filter/.test(globals.dict)) return null;
    chunks.push({ data: globals.bytes, start: 0, end: globals.bytes.length });
  }
  chunks.push({ data: raw, start: 0, end: raw.length });
  const bits = new Jbig2Image().parseChunks(chunks);
  const rowBytes = (width + 7) >> 3;
  if (bits.length < rowBytes * height) return null;
  const blackIsZero = /\/Decode\s*\[\s*1(?:\.0*)?\s+0(?:\.0*)?\s*\]/.test(dict);
  let black: Uint8Array = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * rowBytes;
    for (let x = 0; x < width; x += 1) {
      const bit = ((bits[row + (x >> 3)] ?? 0) >> (7 - (x & 7))) & 1;
      black[y * width + x] = (bit === 1) !== blackIsZero ? 1 : 0;
    }
  }
  black = openSpecks(black, width, height);
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const gray = black[y * width + x] === 1 ? 0 : 255;
      const offset = (y * width + x) * 4;
      out[offset] = gray;
      out[offset + 1] = gray;
      out[offset + 2] = gray;
      out[offset + 3] = 255;
    }
  }
  return { width, height, data: out };
}

function xobjectBody(data: Uint8Array, map: Map<number, number>, dict: string, depth: number): string {
  const inline = /\/XObject\s*<<([\s\S]*?)>>/.exec(dict);
  if (inline) return inline[1] ?? "";
  const indirect = /\/XObject\s+(\d+)\s+\d+\s+R/.exec(dict);
  if (indirect) return readObject(data, map, Number(indirect[1]))?.dict ?? "";
  if (depth > 8) return "";
  const resources = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(dict);
  if (resources) {
    const object = readObject(data, map, Number(resources[1]));
    if (object && /\/XObject/.test(object.dict)) return xobjectBody(data, map, object.dict, depth + 1);
  }
  const parent = /\/Parent\s+(\d+)\s+\d+\s+R/.exec(dict);
  if (!parent) return "";
  const object = readObject(data, map, Number(parent[1]));
  if (!object) return "";
  return xobjectBody(data, map, object.dict, depth + 1);
}

/**
 * 3x3 morphological opening of the black pixels: erode, then dilate. Office scanners dither gray
 * shading (headers, table fills) into isolated dots that Tesseract reads as stray characters. The
 * opening removes dots and hairlines thinner than 3 px and leaves 300 dpi text strokes intact.
 */
function openSpecks(black: Uint8Array, width: number, height: number): Uint8Array {
  const pass = (src: Uint8Array, erode: boolean, horizontal: boolean): Uint8Array => {
    const dst = new Uint8Array(src.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        const a = horizontal ? (x > 0 ? src[i - 1] : src[i]) : y > 0 ? src[i - width] : src[i];
        const b = src[i];
        const c = horizontal ? (x < width - 1 ? src[i + 1] : src[i]) : y < height - 1 ? src[i + width] : src[i];
        dst[i] = erode ? (a! & b! & c!) : (a! | b! | c!);
      }
    }
    return dst;
  };
  const eroded = pass(pass(black, true, true), true, false);
  return pass(pass(eroded, false, true), false, false);
}

function rasterizeMask(raw: Uint8Array, dict: string, width: number, height: number): Rgba | null {
  const parms = /\/DecodeParms\s*<<([\s\S]*?)>>/.exec(dict)?.[1] ?? "";
  const columns = Number(/\/Columns\s+(\d+)/.exec(parms)?.[1] ?? width);
  if (!Number.isFinite(columns) || columns < 8) return null;
  const k = /\/K\s+(-?\d+)/.exec(parms);
  let pos = 0;
  const decoder = new CCITTFaxDecoder(
    {
      next(): number {
        if (pos >= raw.length) return -1;
        const value = raw[pos] ?? -1;
        pos += 1;
        return value;
      },
    },
    {
      K: k ? Number(k[1]) : -1,
      Columns: columns,
      Rows: 0,
      EndOfBlock: flag(parms, "EndOfBlock", true),
      EndOfLine: flag(parms, "EndOfLine", false),
      EncodedByteAlign: flag(parms, "EncodedByteAlign", false),
      BlackIs1: flag(parms, "BlackIs1", false),
    },
  );
  const rowBytes = Math.ceil(columns / 8);
  const cap = rowBytes * (height > 0 ? height + 4 : 8000);
  const packed = new Uint8Array(cap);
  let length = 0;
  while (length < cap) {
    const value = decoder.readNextChar();
    if (value < 0) break;
    packed[length] = value & 255;
    length += 1;
  }
  const rows = Math.floor(length / rowBytes);
  if (rows < 8) return null;
  const bits = packed.subarray(0, rows * rowBytes);
  const invert = mostlyBlack(bits, columns, rows);
  const data = new Uint8Array(columns * rows * 4);
  for (let y = 0; y < rows; y += 1) {
    const row = y * rowBytes;
    for (let x = 0; x < columns; x += 1) {
      const byte = bits[row + (x >> 3)] ?? 0;
      const white = ((byte >> (7 - (x & 7))) & 1) === 1;
      const gray = white === invert ? 0 : 255;
      const offset = (y * columns + x) * 4;
      data[offset] = gray;
      data[offset + 1] = gray;
      data[offset + 2] = gray;
      data[offset + 3] = 255;
    }
  }
  return { width: columns, height: rows, data };
}

function mostlyBlack(packed: Uint8Array, columns: number, rows: number): boolean {
  const rowBytes = Math.ceil(columns / 8);
  const step = Math.max(1, Math.floor(rows / 80));
  let black = 0;
  let total = 0;
  for (let y = 0; y < rows; y += step) {
    const row = y * rowBytes;
    for (let x = 0; x < columns; x += 4) {
      const byte = packed[row + (x >> 3)] ?? 255;
      if ((((byte >> (7 - (x & 7))) & 1) === 0)) black += 1;
      total += 1;
    }
  }
  return total > 0 && black / total > 0.5;
}

function flag(parms: string, name: string, fallback: boolean): boolean {
  if (new RegExp(`/${name}\\s+false`).test(parms)) return false;
  if (new RegExp(`/${name}\\s+true`).test(parms)) return true;
  return fallback;
}

function collectPages(data: Uint8Array, map: Map<number, number>, id: number, seen: Set<number>): number[] {
  if (!Number.isFinite(id) || seen.has(id)) return [];
  seen.add(id);
  const object = readObject(data, map, id);
  if (!object) return [];
  if (/\/Type\s*\/Pages\b/.test(object.dict)) {
    const kids = /\/Kids\s*\[([^\]]*)\]/.exec(object.dict)?.[1] ?? "";
    const pages: number[] = [];
    for (const match of kids.matchAll(/(\d+)\s+\d+\s+R/g)) {
      pages.push(...collectPages(data, map, Number(match[1]), seen));
    }
    return pages;
  }
  if (/\/Type\s*\/Page\b/.test(object.dict)) return [id];
  return [];
}

function readObject(data: Uint8Array, map: Map<number, number>, id: number): PdfObject | null {
  const offset = map.get(id);
  if (offset == null) return null;
  const head = latin1(data, offset, 32);
  const header = /^(\d+)\s+(\d+)\s+obj/.exec(head);
  if (!header) return null;
  const bodyAt = offset + header[0].length;
  const streamAt = findAscii(data, "stream", bodyAt);
  const endobj = findAscii(data, "endobj", bodyAt);
  if (endobj < 0) return null;
  if (streamAt >= 0 && streamAt < endobj) {
    const dict = latin1(data, bodyAt, streamAt - bodyAt);
    const length = Number(/\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict)?.[1]);
    if (!Number.isFinite(length) || length < 0) return { dict, bytes: null };
    let start = streamAt + "stream".length;
    if (data[start] === 0x0d && data[start + 1] === 0x0a) start += 2;
    else if (data[start] === 0x0a) start += 1;
    const end = Math.min(data.length, start + length);
    return { dict, bytes: data.subarray(start, end) };
  }
  return { dict: latin1(data, bodyAt, endobj - bodyAt), bytes: null };
}

function parseXref(data: Uint8Array, offset: number): { map: Map<number, number>; trailer: string } | null {
  const window = latin1(data, offset, Math.min(data.length - offset, 2_000_000)).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (!window.startsWith("xref")) return null;
  const trailerAt = window.indexOf("\ntrailer");
  const body = trailerAt === -1 ? window : window.slice(0, trailerAt);
  const lines = body.split("\n");
  const map = new Map<number, number>();
  let index = 1;
  while (index < lines.length) {
    const head = /^(\d+)\s+(\d+)$/.exec((lines[index] ?? "").trim());
    if (!head) {
      index += 1;
      continue;
    }
    const start = Number(head[1]);
    const count = Number(head[2]);
    index += 1;
    for (let n = 0; n < count && index < lines.length; n += 1, index += 1) {
      const entry = /^(\d+)\s+(\d+)\s+([nf])/.exec((lines[index] ?? "").trim());
      if (entry?.[3] === "n") map.set(start + n, Number(entry[1]));
    }
  }
  const trailer = trailerAt === -1 ? "" : window.slice(trailerAt, trailerAt + 2000);
  if (!trailer.includes("/Root")) return null;
  return { map, trailer };
}

function findStartXref(data: Uint8Array): number | null {
  const tail = latin1(data, Math.max(0, data.length - 4096), Math.min(4096, data.length));
  const matches = [...tail.matchAll(/startxref\s+(\d+)/g)];
  const last = matches.at(-1);
  if (!last?.[1]) return null;
  const offset = Number(last[1]);
  return Number.isFinite(offset) && offset >= 0 && offset < data.length ? offset : null;
}

function includesAscii(data: Uint8Array, needle: string): boolean {
  return findAscii(data, needle, 0) >= 0;
}

function findAscii(data: Uint8Array, needle: string, from: number): number {
  const start = Math.max(0, from);
  const limit = data.length - needle.length;
  for (let i = start; i <= limit; i += 1) {
    let found = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (data[i + j] !== needle.charCodeAt(j)) {
        found = false;
        break;
      }
    }
    if (found) return i;
  }
  return -1;
}

function latin1(data: Uint8Array, start: number, length: number): string {
  const begin = Math.max(0, start);
  const end = Math.min(data.length, begin + Math.max(0, length));
  return new TextDecoder("latin1").decode(data.subarray(begin, end));
}
