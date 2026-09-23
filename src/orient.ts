/** RGBA, row-major, 4 bytes per pixel. */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

export type QuarterTurn = 0 | 90 | 270;

/**
 * Portrait scans of landscape bills need a quarter turn before OCR.
 * Bilevel fax masks pick the direction from text-line balance (duplex backs
 * are the opposite way from fronts). Grayscale photos only report that the
 * text is sideways; the caller probes both directions.
 */
export function orientationOf(image: Rgba): { turn: QuarterTurn } | { probe: true } {
  if (!isSideways(image)) return { turn: 0 };
  if (!isBilevel(image)) return { probe: true };
  return { turn: bilevelQuarterTurn(image) };
}

export function rotateRgba(image: Rgba, turn: QuarterTurn): Rgba {
  if (turn === 0) return image;
  const width = image.height;
  const height = image.width;
  const data = new Uint8Array(width * height * 4);
  const src = image.data;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const from = (y * image.width + x) * 4;
      const nx = turn === 90 ? image.height - 1 - y : y;
      const ny = turn === 90 ? x : image.width - 1 - x;
      const to = (ny * width + nx) * 4;
      data[to] = src[from] ?? 0;
      data[to + 1] = src[from + 1] ?? 0;
      data[to + 2] = src[from + 2] ?? 0;
      data[to + 3] = 255;
    }
  }
  return { width, height, data };
}

function isSideways(image: Rgba): boolean {
  const row = projectionScore(image, "row");
  const col = projectionScore(image, "col");
  return col > row * 1.35;
}

function isBilevel(image: Rgba): boolean {
  const step = sampleStep(image.width, image.height);
  let extreme = 0;
  let count = 0;
  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      const gray = image.data[(y * image.width + x) * 4] ?? 255;
      if (gray < 16 || gray > 240) extreme += 1;
      count += 1;
    }
  }
  return count > 0 && extreme / count > 0.9;
}

/** Lower line-balance is the upright direction for these fax masks. */
function bilevelQuarterTurn(image: Rgba): 90 | 270 {
  const cw = lineBalance(image, 90);
  const ccw = lineBalance(image, 270);
  return cw <= ccw ? 90 : 270;
}

function sampleStep(width: number, height: number): number {
  return Math.max(1, Math.round(Math.max(width, height) / 575));
}

function inkThreshold(image: Rgba): number {
  const step = Math.max(1, Math.round(Math.max(image.width, image.height) / 80));
  let sum = 0;
  let count = 0;
  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      sum += image.data[(y * image.width + x) * 4] ?? 255;
      count += 1;
    }
  }
  const mean = count ? sum / count : 255;
  return Math.min(190, mean - 12);
}

function projectionScore(image: Rgba, axis: "row" | "col"): number {
  const step = sampleStep(image.width, image.height);
  const sw = Math.ceil(image.width / step);
  const sh = Math.ceil(image.height / step);
  const bins = axis === "row" ? sh : sw;
  const proj = new Float64Array(bins);
  const threshold = inkThreshold(image);
  for (let y = 0; y < sh; y += 1) {
    const sy = Math.min(image.height - 1, y * step);
    for (let x = 0; x < sw; x += 1) {
      const sx = Math.min(image.width - 1, x * step);
      const gray = image.data[(sy * image.width + sx) * 4] ?? 255;
      if (gray < threshold) proj[axis === "row" ? y : x] += 1;
    }
  }
  return highPassVariance(proj);
}

function highPassVariance(proj: Float64Array): number {
  const count = proj.length;
  if (count === 0) return 0;
  const win = Math.max(3, Math.round(count / 30));
  const high = new Float64Array(count);
  let acc = 0;
  for (let i = 0; i < count; i += 1) {
    acc += proj[i] ?? 0;
    if (i >= win) acc -= proj[i - win] ?? 0;
    const denom = Math.min(i + 1, win);
    high[i] = (proj[i] ?? 0) - acc / denom;
  }
  let mean = 0;
  for (let i = 0; i < count; i += 1) mean += high[i] ?? 0;
  mean /= count;
  let variance = 0;
  for (let i = 0; i < count; i += 1) {
    const delta = (high[i] ?? 0) - mean;
    variance += delta * delta;
  }
  return variance / count;
}

function lineBalance(image: Rgba, turn: 90 | 270): number {
  const step = 4;
  const width = image.height;
  const height = image.width;
  const sw = Math.floor(width / step);
  const sh = Math.floor(height / step);
  const row = new Int32Array(sh);
  const threshold = inkThreshold(image);
  for (let y = 0; y < sh; y += 1) {
    for (let x = 0; x < sw; x += 1) {
      const point = sourcePixel(image, turn, x * step, y * step);
      if (!point) continue;
      const gray = image.data[(point.y * image.width + point.x) * 4] ?? 255;
      if (gray < threshold) row[y] += 1;
    }
  }
  const band = sw * 0.012;
  let up = 0;
  let down = 0;
  let start = -1;
  for (let y = 0; y <= sh; y += 1) {
    const on = y < sh && (row[y] ?? 0) > band;
    if (on && start < 0) start = y;
    if (!on && start >= 0) {
      const end = y - 1;
      const heightPx = end - start;
      if (heightPx >= 2 && heightPx <= 16) {
        const mid = (start + end) / 2;
        let top = 0;
        let bottom = 0;
        for (let yy = start; yy <= end; yy += 1) {
          if (yy < mid) top += row[yy] ?? 0;
          else bottom += row[yy] ?? 0;
        }
        if (top > bottom * 1.08) up += 1;
        else if (bottom > top * 1.08) down += 1;
      }
      start = -1;
    }
  }
  return (up - down) / Math.max(1, up + down);
}

function sourcePixel(image: Rgba, turn: 90 | 270, x: number, y: number): { x: number; y: number } | null {
  const sx = turn === 90 ? y : image.width - 1 - y;
  const sy = turn === 90 ? image.height - 1 - x : x;
  if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) return null;
  return { x: sx, y: sy };
}
