import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { extractImages, getDocumentProxy } from "unpdf";
import { PNG } from "pngjs";

type OpenPdf = Awaited<ReturnType<typeof getDocumentProxy>>;

const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const PAGE_BREAK = "\n----- PAGE -----\n";
const TRAINEDDATA_URL = "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz";
const CORE_VERSION = "5.1.1";

export interface BillVision {
  run(
    model: typeof VISION_MODEL,
    inputs: { prompt: string; image?: number[] | string; max_tokens?: number },
  ): Promise<unknown>;
}

interface PageImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  channels: 1 | 3 | 4;
}

interface TessApi {
  Init(datapath: string | null, language: string, oem: number): number;
  SetPageSegMode(mode: number): void;
  SetImageFile(): number;
  Recognize(monitor: null): boolean;
  GetUTF8Text(): string;
  Clear(): void;
}

interface TessModule {
  FS: {
    writeFile(path: string, data: Uint8Array | string): void;
  };
  TessBaseAPI: new () => TessApi;
}

type CoreFactory = (options?: { wasmBinary?: ArrayBuffer; print?: () => void; printErr?: () => void }) => Promise<TessModule>;

let recognizerPromise: Promise<(png: Uint8Array) => Promise<string>> | undefined;

/** Letters below this count mean the PDF has no usable text layer. */
export function textLayerIsEmpty(text: string): boolean {
  const letters = text.match(/[A-Za-z]/g);
  return (letters?.length ?? 0) < 40;
}

export async function ocrPdfDocument(pdf: OpenPdf, ai?: BillVision): Promise<string> {
  const parts: string[] = [];
  for (let page = 1; page <= pdf.numPages; page += 1) {
    parts.push(await ocrPage(pdf, page, ai));
  }
  return parts.join(PAGE_BREAK);
}

async function ocrPage(pdf: OpenPdf, page: number, ai?: BillVision): Promise<string> {
  let images: PageImage[] = [];
  try {
    images = await extractImages(pdf, page);
  } catch {
    return "";
  }
  const image = largest(images);
  if (!image) return "";
  const png = imageToGrayscalePng(image);
  if (ai) {
    const transcribed = await transcribeWithVision(ai, png);
    if (!textLayerIsEmpty(transcribed) && /\b(?:kwh|account|schedule)\b/i.test(transcribed)) return transcribed;
  }
  try {
    const recognize = await localRecognizer();
    return await recognize(png);
  } catch {
    return "";
  }
}

function largest(images: readonly PageImage[]): PageImage | undefined {
  return images.reduce<PageImage | undefined>((best, image) => {
    if (!best) return image;
    return image.width * image.height > best.width * best.height ? image : best;
  }, undefined);
}

function imageToGrayscalePng(image: PageImage): Uint8Array {
  const png = new PNG({ width: image.width, height: image.height });
  const src = image.data;
  const channels = image.channels;
  for (let i = 0, pixel = 0; i < src.length; i += channels, pixel += 4) {
    const gray =
      channels === 1
        ? src[i] ?? 0
        : Math.round(0.299 * (src[i] ?? 0) + 0.587 * (src[i + 1] ?? 0) + 0.114 * (src[i + 2] ?? 0));
    png.data[pixel] = gray;
    png.data[pixel + 1] = gray;
    png.data[pixel + 2] = gray;
    png.data[pixel + 3] = 255;
  }
  return PNG.sync.write(png);
}

async function transcribeWithVision(ai: BillVision, png: Uint8Array): Promise<string> {
  try {
    const small = downscalePng(png, 1200);
    const result = await ai.run(VISION_MODEL, {
      prompt:
        "Transcribe this scanned utility bill into plain text. Keep account numbers, dates, meter readings, kWh, kW, schedule, and New Charges on their own lines. Do not summarize or invent values.",
      image: Buffer.from(small).toString("base64"),
      max_tokens: 2500,
    });
    return visionText(result);
  } catch {
    return "";
  }
}

function visionText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  if ("response" in result && typeof result.response === "string") return result.response;
  if ("description" in result && typeof result.description === "string") return result.description;
  return "";
}

function downscalePng(png: Uint8Array, maxWidth: number): Uint8Array {
  const src = PNG.sync.read(Buffer.from(png));
  if (src.width <= maxWidth) return png;
  const scale = maxWidth / src.width;
  const width = maxWidth;
  const height = Math.max(1, Math.round(src.height * scale));
  const dst = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(src.height - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(src.width - 1, Math.floor(x / scale));
      const from = (sourceY * src.width + sourceX) * 4;
      const to = (y * width + x) * 4;
      dst.data[to] = src.data[from] ?? 0;
      dst.data[to + 1] = src.data[from + 1] ?? 0;
      dst.data[to + 2] = src.data[from + 2] ?? 0;
      dst.data[to + 3] = 255;
    }
  }
  return PNG.sync.write(dst);
}

/**
 * In-process LSTM OCR. Cloudflare Workers cannot spawn the worker thread tesseract.js uses,
 * so this loads tesseract.js-core in the same isolate. SIMD is preferred. wasm and eng.traineddata
 * come from node_modules when that directory is readable, otherwise from jsDelivr.
 */
function localRecognizer(): Promise<(png: Uint8Array) => Promise<string>> {
  recognizerPromise ??= startRecognizer().catch((error: unknown) => {
    recognizerPromise = undefined;
    throw error;
  });
  return recognizerPromise;
}

async function startRecognizer(): Promise<(png: Uint8Array) => Promise<string>> {
  const simd = await wasmSimd();
  let engine = await startCore(simd);
  if (!engine && simd) engine = await startCore(false);
  if (!engine) throw new Error("tesseract core failed to start");
  const { api, mod } = engine;
  return async (png: Uint8Array) => {
    try {
      mod.FS.writeFile("/input", png);
      if (api.SetImageFile() === 1) return "";
      api.Recognize(null);
      return api.GetUTF8Text() ?? "";
    } finally {
      try {
        api.Clear();
      } catch {
        /* the next page still attempts recognition */
      }
    }
  };
}

async function startCore(simd: boolean): Promise<{ api: TessApi; mod: TessModule } | undefined> {
  try {
    const suffix = simd ? "tesseract-core-simd-lstm" : "tesseract-core-lstm";
    const factory = await loadCore(suffix);
    const wasmBinary = await loadBytes(
      `tesseract.js-core/${suffix}.wasm`,
      `https://cdn.jsdelivr.net/npm/tesseract.js-core@v${CORE_VERSION}/${suffix}.wasm`,
    );
    const trained = await loadTraineddata();
    const mod = await factory({
      wasmBinary,
      print: () => undefined,
      printErr: () => undefined,
    });
    mod.FS.writeFile("eng.traineddata", trained);
    const api = new mod.TessBaseAPI();
    if (api.Init(null, "eng", 1) === -1) return undefined;
    api.SetPageSegMode(6);
    return { api, mod };
  } catch {
    return undefined;
  }
}

async function loadCore(suffix: string): Promise<CoreFactory> {
  const imported = (
    suffix === "tesseract-core-simd-lstm"
      ? await import("tesseract.js-core/tesseract-core-simd-lstm.js")
      : await import("tesseract.js-core/tesseract-core-lstm.js")
  ) as { default?: CoreFactory };
  const factory = imported.default;
  if (typeof factory !== "function") throw new Error(`missing ${suffix} export`);
  return factory;
}

async function loadTraineddata(): Promise<Uint8Array> {
  const local = await readOptional("eng.traineddata");
  if (local && local.byteLength > 1000) return local;
  const packed = await loadBytes("@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", TRAINEDDATA_URL);
  return gunzip(new Uint8Array(packed));
}

async function loadBytes(specifier: string, url: string): Promise<ArrayBuffer> {
  const resolved = resolvePackageFile(specifier);
  if (resolved) {
    try {
      const bytes = await readFile(resolved);
      if (bytes.byteLength > 0) return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    } catch {
      /* Workers cannot read node_modules. Fetch the same file below. */
    }
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch ${url} failed: ${response.status}`);
  return response.arrayBuffer();
}

function resolvePackageFile(specifier: string): string | undefined {
  try {
    return createRequire(import.meta.url).resolve(specifier);
  } catch {
    return undefined;
  }
}

async function readOptional(path: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    return undefined;
  }
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (!(bytes[0] === 0x1f && bytes[1] === 0x8b)) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function wasmSimd(): Promise<boolean> {
  try {
    return WebAssembly.validate(
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]),
    );
  } catch {
    return false;
  }
}
