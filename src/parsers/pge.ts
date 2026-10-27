import { emptyBill, type BillDraft, type BillParser } from "./base";
import type { ChargeCategory, ChargeLine } from "./charges";

/**
 * PG&E "Energy Statements" for a business rate (B-10 Secondary is the tested sample) with
 * generation from a CCA (Ava Community Energy is the tested sample).
 *
 * The input is usually OCR text of a scan: one "Details of PG&E Electric Delivery Charges" page
 * and one "Details of <CCA> Electric Generation Charges" page per billing period. OCR misreads
 * digits, drops decimal points and minus signs, and appends right-column text to lines, so every
 * value is collected as a set of candidate readings and the row is accepted only when one choice
 * per line satisfies all of the bill's own arithmetic:
 *
 * - each kWh, kW, and day line equals quantity x printed rate (demand prorated by segment days)
 * - TOU kWh add up to Total Usage, and the CCA page repeats the same kWh per TOU period
 * - delivery lines add up to Total PG&E Electric Delivery Charges
 * - each segment's Utility Users' Tax is that rate times the segment's lines before the Franchise
 *   Fee Surcharge (the bill does not tax the FFS)
 * - CCA lines add up to Net Charges, and Net + UUT + Energy Commission Tax = the CCA total
 *
 * One row per period combines delivery and generation, so total_new_charges_usd is what the
 * customer pays for that period. A period that cannot be reconciled is stored `failed` with
 * `needs_review: `.
 */
export const PGE_PARSER_ID = "pge-business-cca";

const PAGE_BREAK = /\n-{3,} PAGE -{3,}\n/;
const TOU_BUCKETS = ["peak", "part_peak", "off_peak", "super_off_peak"] as const;
type Bucket = (typeof TOU_BUCKETS)[number];
const BUCKET_COLUMN: Record<Bucket, "kwh_on_peak" | "kwh_mid_peak" | "kwh_off_peak" | "kwh_super_off_peak"> = {
  peak: "kwh_on_peak",
  part_peak: "kwh_mid_peak",
  off_peak: "kwh_off_peak",
  super_off_peak: "kwh_super_off_peak",
};
const MICRO = 1_000_000;
const MAX_COMBOS = 200_000;

export const pgeParser: BillParser = {
  id: PGE_PARSER_ID,
  match(text: string): boolean {
    return /Electric\s+Delivery\s+Charges/i.test(text) && /pge\.com|PG\s*&\s*E/i.test(text) && /Rate\s+Schedule/i.test(text);
  },
  parse(text: string, sourceFile: string): BillDraft[] {
    return parsePgeBills(text, sourceFile);
  },
};

// ---------- readings ----------

/** Integer candidates for a value printed with `places` decimals (cents, micro-kWh, ...). */
function readings(raw: string, places: number, opts: { negative?: boolean; maxInt?: number } = {}): number[] {
  const out = new Set<number>();
  const scale = 10 ** places;
  const s = raw
    .replace(/[Oo](?=\d)|(?<=\d)[Oo]/g, "0")
    .replace(/(?<=\d)[lI|](?=\d)/g, "1")
    .replace(/(\d)[:;](\d{2})(?!\d)/g, "$1.$2");
  // A decimal point read as a space ("-94 91"): one more reading of the whole token.
  if (places === 2) for (const m of s.matchAll(/(?<![\d.])(-?\d{1,4}) (\d{2})(?![\d.])/g)) {
    const v = Number(m[1]!.replace("-", "") + m[2]);
    const neg = m[1]!.startsWith("-");
    out.add(neg || opts.negative ? -v : v);
    if (opts.negative === undefined && !neg) out.add(-v);
  }
  for (const m of s.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
    const token = m[0];
    const neg = token.startsWith("-");
    const body = token.replace(/^-/, "").replace(/,/g, "");
    const dot = body.indexOf(".");
    const values: number[] = [];
    if (dot >= 0) {
      const frac = body.slice(dot + 1);
      const int = body.slice(0, dot);
      if (frac.length === places) values.push(Number(int + frac));
      else if (frac.length > places && places > 0) values.push(Number(int + frac.slice(0, places)));
    } else if (body.length > places && places > 0) {
      values.push(Number(body)); // lost decimal point
    }
    for (const v of values) {
      if (!Number.isFinite(v)) continue;
      if (opts.maxInt != null && v / scale > opts.maxInt) continue;
      const signed = neg || opts.negative ? -v : v;
      out.add(signed);
      if (opts.negative === undefined && !neg) out.add(-v);
    }
  }
  return [...out];
}

function money(raw: string, opts: { negative?: boolean } = {}): number[] {
  // An amount is the last token on the line before the right-hand column text.
  const amounts = readings(raw, 2, { ...opts, maxInt: 100_000 });
  return amounts;
}

function firstRate(raw: string, places: number): number | null {
  const at = raw.indexOf("@");
  const tail = at >= 0 ? raw.slice(at + 1) : raw;
  const compact = tail.replace(/\$\s+/g, "$").replace(/^\s+/, "");
  const m = new RegExp(`^\\S*?(\\d{0,2})[.,](\\d{${places}})(?!\\d)`).exec(compact);
  if (!m) return null;
  return Number(`${m[1] && m[1].length <= 2 ? m[1] : "0"}.${m[2]}`);
}

function lineAfter(text: string, label: RegExp): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = label.exec(line);
    if (m) out.push(line.slice((m.index ?? 0) + m[0].length));
  }
  return out;
}

function fixRight(raw: string): string {
  // Drop right-column text (RIN codes, meter box, help text) that OCR appends to charge lines.
  return raw
    .replace(/USCA[\s\S]*$/i, "")
    .replace(/(?:Meter|Neer|Meier)\s*#[\s\S]*$/i, "")
    .replace(/(?:Total\s*Us|Serial|Rotating|To program|QR\s*code|follow the|Service Information|www\.|please contact|AVA\s*COMMUNITY|For questions|Additional Messages)[\s\S]*$/i, "");
}

// ---------- page model ----------

interface Triple {
  label: string;
  qty: number[]; // micro units (kWh or kW) or whole days
  rate: number | null;
  amount: number[]; // cents
}

interface Segment {
  customer: Triple | null;
  demand: Triple | null;
  tou: Partial<Record<Bucket, Triple>>;
  gen: number[];
  pcia: number[];
  ffs: number[];
  uut: number[];
  uutRate: number | null;
}

interface DeliveryPage {
  period: { start: string; end: string; days: number } | null;
  statementDate: string;
  dueDate: string;
  rateSchedule: string;
  segments: Segment[];
  total: number[];
  usage: number[];
}

interface CcaPage {
  period: { start: string; end: string; days: number } | null;
  provider: string;
  product: string;
  lines: Partial<Record<Bucket, Triple & { season: string }>>;
  pcia: number[];
  ffs: number[];
  productAmount: number[];
  net: number[];
  uut: number[];
  uutRate: number | null;
  ect: number[];
  total: number[];
}

function mdyToIso(m: string, d: string, y: string): string {
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function periodOf(page: string): { start: string; end: string; days: number } | null {
  const fixed = page.replace(/\b[tT][o0]\b|\b10(?=\.?\d\d\/)/g, " to ");
  const m = /(\d{2})\/(\d{2})\/(\d{4})\s*[^\d\n]{0,8}?\s*(\d{2})\/(\d{2})\/(\d{4})\s*\(\s*(\d{1,2})\s*billing/i.exec(fixed);
  if (!m) return null;
  const start = mdyToIso(m[1]!, m[2]!, m[3]!);
  const end = mdyToIso(m[4]!, m[5]!, m[6]!);
  const span = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
  if (!Number.isFinite(span) || span < 20 || span > 40) return null;
  return { start, end, days: span };
}

function labeledDate(page: string, label: RegExp): string {
  for (const line of page.split("\n")) {
    if (!label.test(line)) continue;
    const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(line);
    if (m) return mdyToIso(m[1]!, m[2]!, m[3]!);
  }
  return "";
}

function triple(raw: string, label: string, qtyPlaces: number, ratePlaces: number): Triple {
  const body = fixRight(raw);
  const at = body.indexOf("@");
  const qtyPart = at >= 0 ? body.slice(0, at) : body;
  const afterRate = at >= 0 ? body.slice(at + 1).replace(/^\s*\$?\s*\S+/, "") : "";
  const qty = qtyPlaces === 0 ? [...qtyPart.matchAll(/\b(\d{1,2})\b/g)].map((m) => Number(m[1])) : readings(qtyPart, qtyPlaces, { negative: false });
  return { label, qty, rate: firstRate(body, ratePlaces), amount: money(afterRate || body, { negative: false }) };
}

const TOU_LABEL: Array<[Bucket, RegExp]> = [
  ["super_off_peak", /^\s*Super\s*-?\s*Of+\s*-?\s*Peak\b(?!\s*Winter)/i],
  ["part_peak", /^\s*Part\s*-?\s*Peak\b(?!\s*Summer)/i],
  ["off_peak", /^\s*Of+\s*-?\s*Peak\b(?!\s*(?:Summer|Winter))/i],
  ["peak", /^\s*(?:Peak|Peek|Pesk|ek)\b(?!\s*(?:Summer|Winter))/i],
];

function parseDelivery(page: string): DeliveryPage {
  const segments: Segment[] = [];
  let seg: Segment | null = null;
  const newSeg = (): Segment => ({ customer: null, demand: null, tou: {}, gen: [], pcia: [], ffs: [], uut: [], uutRate: null });
  let total: number[] = [];
  for (const line of page.split("\n")) {
    if (/Customer\s*Charge/i.test(line)) {
      seg = newSeg();
      segments.push(seg);
      const raw = line.replace(/^[\s\S]*?Customer\s*Charge/i, "");
      seg.customer = triple(raw, "Customer Charge", 0, 5);
      continue;
    }
    if (/Total\s+PG.{0,3}E?\s+Electric\s+Delivery\s+Charges/i.test(line)) {
      total = money(line.replace(/^[\s\S]*?Charges/i, ""), { negative: false });
      continue;
    }
    if (!seg) continue;
    if ((/Dem\w*\s*Char\w*/i.test(line) && !/prorat/i.test(line)) || (!seg.demand && /\d\.\d{6}\s*k\s*W\b(?!h)/i.test(line))) {
      seg.demand = triple(line.replace(/^[\s\S]*?Dem\w*\s*Char\S*/i, ""), "Demand Charge", 6, 5);
      continue;
    }
    const tou = TOU_LABEL.find(([, re]) => re.test(line));
    if (tou && /kwh|@/i.test(line)) {
      seg.tou[tou[0]] = triple(line.replace(tou[1], ""), tou[0], 6, 5);
      continue;
    }
    if (/Generation\s*Credit/i.test(line)) seg.gen = money(fixRight(line.replace(/^[\s\S]*?Credit/i, "")), { negative: true });
    else if (/Indi\w*\s*Adjustment/i.test(line) && !/Vintaged/i.test(line))
      seg.pcia = money(fixRight(line.replace(/^[\s\S]*?Adjustment/i, "")));
    else if (/Franchise\s*Fee/i.test(line)) seg.ffs = money(fixRight(line.replace(/^[\s\S]*?Surcharge/i, "")));
    else if (/Users.?\s*T\w*x/i.test(line)) {
      const rate = /\((\d+\.\d+)\s*%\)/.exec(line);
      seg.uutRate = rate ? Number(rate[1]) / 100 : null;
      seg.uut = money(fixRight(line.replace(/^[\s\S]*?%\)?/i, "")), { negative: false });
    }
  }
  const usage = new Set<number>();
  for (const raw of lineAfter(page, /Total\s*Us\w*/i)) for (const v of readings(raw, 6, { negative: false })) usage.add(v);
  for (const raw of lineAfter(page, /Usage\s+This\s+P\w*:/i)) for (const v of readings(raw.split("kWh")[0] ?? "", 6, { negative: false })) usage.add(v);
  const schedule = /Rate\s*Schedule:?\s*([A-Z0-9-]{2,8})\b/i.exec(page)?.[1] ?? "";
  return {
    period: periodOf(page),
    statementDate: labeledDate(page, /^(?!.*Due\s*Date).*(?:Statement|Sta\w*\s*Date)/i),
    dueDate: labeledDate(page, /Due\s*Date/i),
    rateSchedule: schedule.toUpperCase().replace(/^8/, "B"),
    segments,
    total,
    usage: [...usage],
  };
}

const CCA_LINE: Array<[Bucket, RegExp]> = [
  ["super_off_peak", /^\s*Super\s*-?\s*Of+\s*-?\s*Peak\s*(Summer|Winter)/i],
  ["part_peak", /^\s*Part\s*-?\s*Peak\s*(Summer|Winter)/i],
  ["off_peak", /^\s*Of+\s*-?\s*Peak\s*(Summer|Winter)/i],
  ["peak", /^\s*Peak\s*(Summer|Winter)/i],
];

function parseCca(page: string): CcaPage {
  const rawProvider = /Details\s+of\s+(.+?)\s+Electric/i.exec(page)?.[1]?.replace(/[^A-Za-z&. ]/g, "").replace(/\s+/g, " ").trim() ?? "";
  // Known CCAs by a loose OCR-tolerant pattern; otherwise keep what was read.
  const provider = /Ava\s*Com|AvaCom|Ava\s*Energy|avaenergy/i.test(rawProvider || page) ? "Ava Community Energy" : rawProvider;
  const productLine = /Rate\s*Schedule:?[^A-Za-z0-9]*([A-Z0-9]+)\s*-\s*([A-Za-z0-9 ]+?)(?:\s{2,}|\s+[^A-Za-z0-9 ]|$)/im.exec(page);
  const product = productLine ? `${productLine[1]!.toUpperCase()}-${productLine[2]!.replace(/Brigh\w*/i, "Bright").replace(/\s+[A-Z]{1,2}$/, "").trim()}` : "";
  const productWord = productLine?.[2]?.trim().split(/\s+/)[0] ?? "Bright";
  const lines: CcaPage["lines"] = {};
  const out: CcaPage = { period: periodOf(page), provider, product, lines, pcia: [], ffs: [], productAmount: [], net: [], uut: [], uutRate: null, ect: [], total: [] };
  const rows = page.split("\n");
  for (let i = 0; i < rows.length; i += 1) {
    const line = rows[i] ?? "";
    const tou = CCA_LINE.find(([, re]) => re.test(line));
    if (tou) {
      const season = tou[1].exec(line)?.[1] ?? "";
      lines[tou[0]] = { ...triple(line.replace(tou[1], ""), `${tou[0]} ${season}`, 6, 5), season };
      continue;
    }
    if (/Indi\w*\s*Adj\w*\s*Credit/i.test(line)) out.pcia = money(fixRight(line.replace(/^[\s\S]*?Credit/i, "")), { negative: true });
    else if (/Franchise\s*Fee\s*Surcharge\s*Credit/i.test(line)) out.ffs = money(fixRight(line.replace(/^[\s\S]*?Credit/i, "")), { negative: true });
    else if (/Net\s*Charges/i.test(line)) out.net = money(fixRight(line.replace(/^[\s\S]*?Charges/i, "")), { negative: false });
    else if (/Utility\s*Users\s*Tax/i.test(line)) {
      const rate = /\((\d+\.\d+)\s*%\)/.exec(line);
      out.uutRate = rate ? Number(rate[1]) / 100 : null;
      out.uut = money(fixRight(line.replace(/^[\s\S]*?%\)?/i, "")), { negative: false });
    } else if (/Energy\s*Commission\s*Tax/i.test(line)) out.ect = money(fixRight(line.replace(/^[\s\S]*?Tax/i, "")), { negative: false });
    else if (/Generation\s*Charges/i.test(line) && /\$/.test(line)) out.total = money(fixRight(line.replace(/^[\s\S]*?Charges/i, "")), { negative: false });
    else if (
      out.productAmount.length === 0 &&
      new RegExp(`^\\s*${productWord.slice(0, 5)}\\w*\\s+${productLine?.[2]?.trim().split(/\s+/)[1]?.slice(0, 4) ?? "Choi"}`, "i").test(line) &&
      !/priced/i.test(line)
    ) {
      out.productAmount = money(fixRight(line.replace(/^\s*\S+\s+\S+/, "")));
    }
  }
  return out;
}

// ---------- reconciliation ----------

const r2 = (cents: number): number => Math.round(cents);

interface Choice {
  delivery: { segs: Array<{ days: number; cust: number; kw: number; dem: number; tou: Partial<Record<Bucket, { q: number; a: number }>>; gen: number; pcia: number; ffs: number; uut: number }>; total: number; usage: number };
  cca: { tou: Partial<Record<Bucket, { q: number; a: number }>>; pcia: number; ffs: number; prod: number; net: number; uut: number; ect: number; total: number };
  computed: string[];
}

/**
 * Options for a qty x rate line, best first: quantity and amount that agree with the printed rate;
 * quantity and amount that agree with a rate one OCR digit away; amount recomputed from quantity
 * x rate; and amount with the quantity left to be solved from Total Usage (q = -1).
 */
function lineOptions(t: Triple | undefined, factor: number, extraQty: number[], unit: number): Array<{ q: number; a: number; computed: boolean }> {
  if (!t) return [];
  const qtys = [...new Set([...t.qty, ...extraQty])].filter((q) => q > 0);
  const amounts = t.amount.filter((a) => a >= 0);
  const out: Array<{ q: number; a: number; computed: boolean }> = [];
  const value = (q: number, rate: number): number => r2((q / unit) * rate * factor * 100);
  if (t.rate != null) {
    const rate = t.rate;
    for (const q of qtys) for (const a of amounts) if (Math.abs(value(q, rate) - a) <= 1) out.push({ q, a, computed: false });
    for (const q of qtys)
      for (const a of amounts) {
        const implied = (a / 100) / ((q / unit) * factor);
        if (Math.abs(implied - rate) / rate < 0.005 && Math.abs(value(q, rate) - a) > 1) out.push({ q, a, computed: true });
      }
    for (const q of qtys) out.push({ q, a: value(q, rate), computed: true });
    for (const a of amounts) out.push({ q: -1, a, computed: true });
  } else {
    for (const q of qtys) for (const a of amounts) out.push({ q, a, computed: true });
    for (const a of amounts) out.push({ q: -1, a, computed: true });
  }
  return dedupe(out);
}

function dedupe<T>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function reconcile(d: DeliveryPage, c: CcaPage | null, periodDays: number): { choice: Choice | null; reason: string } {
  // CCA per-bucket kWh are a second reading of the delivery kWh (summed across segments).
  const single = d.segments.length === 1;
  const ccaQty = (b: Bucket): number[] => (c?.lines[b]?.qty ?? []);
  type SegOpt = Choice["delivery"]["segs"][number] & { comp: string[] };
  const segOptions: SegOpt[][] = [];
  for (const [index, seg] of d.segments.entries()) {
    const cust = seg.customer;
    const custRate = cust?.rate ?? null;
    const dayCands = new Set<number>(cust?.qty ?? []);
    if (single) dayCands.add(periodDays);
    if (custRate) for (const a of cust?.amount ?? []) if (a > 0) dayCands.add(Math.round(a / 100 / custRate));
    const custOpts: Array<{ days: number; a: number; computed: boolean }> = [];
    for (const days of dayCands) {
      if (days < 1 || days > periodDays || !custRate) continue;
      const a = r2(days * custRate * 100);
      custOpts.push({ days, a, computed: !(cust?.amount ?? []).includes(a) });
    }
    custOpts.sort((x, y) => Number(x.computed) - Number(y.computed));
    const touOpts: Partial<Record<Bucket, Array<{ q: number; a: number; computed: boolean }>>> = {};
    for (const b of TOU_BUCKETS) {
      if (!seg.tou[b] && !(single && c?.lines[b])) continue;
      const t = seg.tou[b] ?? { label: b, qty: [], rate: null, amount: [] };
      touOpts[b] = lineOptions(t, 1, single ? ccaQty(b) : [], MICRO).sort((x, y) => Number(x.computed) - Number(y.computed));
    }
    const opts: SegOpt[] = [];
    const touKeys = Object.keys(touOpts) as Bucket[];
    for (const co of custOpts.slice(0, 3)) {
      const factor = d.segments.length > 1 ? co.days / periodDays : 1;
      const demOpts = lineOptions(seg.demand ?? undefined, factor, [], MICRO).sort((x, y) => Number(x.computed) - Number(y.computed)).slice(0, 4);
      const touLists = touKeys.map((b) => (touOpts[b] ?? []).slice(0, 6));
      for (const dem of demOpts) {
        for (const combo of product(touLists)) {
          const tou: SegOpt["tou"] = {};
          const comp: string[] = [];
          if (co.computed) comp.push(`seg${index + 1} customer`);
          if (dem.computed) comp.push(`seg${index + 1} demand`);
          touKeys.forEach((b, i) => {
            const o = combo[i]!;
            tou[b] = { q: o.q, a: o.a };
            if (o.computed) comp.push(`seg${index + 1} ${b}`);
          });
          // NaN = "misread": solved later from the printed delivery total (at most one per period).
          for (const gen of [...seg.gen, NaN])
            for (const pcia of [...seg.pcia.filter((v) => v >= 0), NaN])
              for (const ffs of [...seg.ffs.filter((v) => v >= 0), NaN]) {
                if (Number(Number.isNaN(gen)) + Number(Number.isNaN(pcia)) + Number(Number.isNaN(ffs)) > 1) continue;
                const base = co.a + dem.a + sum(Object.values(tou).map((v) => v!.a));
                const uutRate = seg.uutRate ?? 0.05;
                const uutPrinted = seg.uut.filter((v) => v >= 0);
                const pre = base + (Number.isNaN(gen) ? 0 : gen) + (Number.isNaN(pcia) ? 0 : pcia);
                const uutCalc = r2(pre * uutRate);
                // The UUT is always the computed 5% of the pre-FFS base (NaN until gen/pcia are known);
                // a printed UUT that disagrees is a misread and costs one "computed".
                const uut = !Number.isNaN(gen) && !Number.isNaN(pcia) ? uutCalc : NaN;
                const uutOk = Number.isNaN(uut) || uutPrinted.includes(uut);
                opts.push({ days: co.days, cust: co.a, kw: dem.q, dem: dem.a, tou, gen, pcia, ffs, uut, comp: uutOk ? comp : [...comp, `seg${index + 1} uut`] });
              }
        }
      }
    }
    // Fewest recomputed values first; keep the search bounded (segments multiply).
    opts.sort((x, y) => x.comp.length - y.comp.length);
    segOptions.push(opts.slice(0, single ? 40000 : 400));
  }
  if (segOptions.some((o) => o.length === 0)) return { choice: null, reason: "a delivery segment has unreadable lines" };

  const usageCands = new Set(d.usage);
  if (c) {
    const ccaTotal = sum(TOU_BUCKETS.map((b) => c.lines[b]?.qty[0] ?? 0));
    if (ccaTotal > 0) usageCands.add(ccaTotal);
  }
  let best: Choice | null = null;
  let tried = 0;
  for (const segs of product(segOptions)) {
    tried += 1;
    if (tried > MAX_COMBOS) break;
    const comp = segs.flatMap((s) => s.comp);
    // Missing gen/pcia/ffs: at most one unknown, solved from the printed total.
    const unknown: Array<[number, "gen" | "pcia" | "ffs"]> = [];
    segs.forEach((s, i) => (["gen", "pcia", "ffs"] as const).forEach((k) => Number.isNaN(s[k]) && unknown.push([i, k])));
    const known = sum(segs.map((s) => s.cust + s.dem + sum(Object.values(s.tou).map((v) => v!.a)) + nz(s.gen) + nz(s.pcia) + nz(s.ffs) + nz(s.uut)));
    for (const total of d.total.length ? d.total : [NaN]) {
      let fixed = segs.map((s) => ({ ...s, tou: { ...s.tou } }));
      if (Number.isNaN(total)) continue;
      if (unknown.length > 1) continue;
      if (unknown.length === 1) {
        const [i, k] = unknown[0]!;
        const s0 = fixed[i]!;
        const rate = d.segments[i]?.uutRate ?? 0.05;
        if (k === "ffs") {
          fixed[i] = { ...s0, ffs: total - known };
        } else {
          // total = others + x + round(rate * (pre + x)): solve for x near the continuous solution.
          const pre = s0.cust + s0.dem + sum(Object.values(s0.tou).map((v) => v!.a)) + nz(s0.gen) + nz(s0.pcia);
          const others = known - nz(s0.uut);
          const x0 = Math.round((total - others - rate * pre) / (1 + rate));
          const x = [x0, x0 - 1, x0 + 1, x0 - 2, x0 + 2].find((v) => others + v + r2(rate * (pre + v)) === total);
          if (x === undefined) continue;
          fixed[i] = { ...s0, [k]: x, uut: r2(rate * (pre + x)) };
          if (!d.segments[i]!.uut.includes(fixed[i]!.uut)) comp.push(`seg${i + 1} uut`);
        }
        comp.push(`seg${i + 1} ${k} from total`);
      } else if (known !== total) continue;
      if (fixed.some((s) => Number.isNaN(s.uut))) continue;
      // kWh: TOU sum equals Total Usage; quantities solved by amount/rate (-1) must come from it.
      const qs = fixed.flatMap((s) => Object.values(s.tou).map((v) => v!.q));
      const missing = qs.filter((q) => q < 0).length;
      if (missing > 1) continue;
      let usage = NaN;
      for (const u of usageCands) {
        if (missing === 0 && sum(qs) === u) usage = u;
        if (missing === 1 && Number.isNaN(usage)) {
          const solved = u - sum(qs.filter((q) => q >= 0));
          // the solved kWh must reproduce that line's amount at its printed rate
          const at = fixed.findIndex((s) => Object.values(s.tou).some((v) => v!.q < 0));
          const seg = fixed[at]!;
          const bucket = (Object.keys(seg.tou) as Bucket[]).find((k) => seg.tou[k]!.q < 0)!;
          const rate = d.segments[at]?.tou[bucket]?.rate ?? c?.lines[bucket]?.rate ?? null;
          const line = seg.tou[bucket]!;
          const okRate = rate == null ? false : Math.abs(r2((solved / MICRO) * rate * 100) - line.a) <= 1;
          if (solved > 0 && okRate) {
            seg.tou = { ...seg.tou, [bucket]: { q: solved, a: line.a } };
            usage = u;
            comp.push(`seg${at + 1} ${bucket} kWh from total usage`);
          }
        }
      }
      if (Number.isNaN(usage) && missing === 0 && usageCands.size === 0) usage = sum(qs);
      if (Number.isNaN(usage)) continue;
      // PCIA and FFS are flat per-kWh rates printed to 5 decimals ($0.03780, $0.00061):
      // a value that no such rate reproduces is a misread (or absorbed another misread).
      if (!fixed.every((s) => flatRate(sum(Object.values(s.tou).map((v) => v!.q)), s.pcia) && flatRate(sum(Object.values(s.tou).map((v) => v!.q)), s.ffs))) continue;
      const cca = c ? reconcileCca(c, fixed, usage) : null;
      if (c && !cca) continue;
      const choice: Choice = {
        delivery: { segs: fixed.map(({ comp: _comp, ...s }) => s), total, usage },
        cca: cca?.value ?? { tou: {}, pcia: 0, ffs: 0, prod: 0, net: 0, uut: 0, ect: 0, total: 0 },
        computed: [...comp, ...(cca?.computed ?? [])],
      };
      if (!best || cost(choice.computed) < cost(best.computed)) best = choice;
      if (best.computed.length === 0) return { choice: best, reason: "" };
    }
  }
  if (!best) return { choice: null, reason: tried > MAX_COMBOS ? "too many readings to reconcile" : "lines do not add up to the printed totals" };
  return { choice: best, reason: "" };
}

/** True when some $/kWh rate with 5 decimals turns `micro` kWh into exactly `cents`. */
function flatRate(micro: number, cents: number): boolean {
  const kwh = micro / MICRO;
  if (kwh <= 0) return cents === 0;
  const r0 = Math.round((cents / 100 / kwh) * 1e5);
  return [r0 - 1, r0, r0 + 1].some((r) => r >= 0 && Math.round(kwh * (r / 1e5) * 100) === cents);
}

/** Values solved from a total can absorb another misread, so they cost more than a recompute. */
function cost(computed: string[]): number {
  return sum(computed.map((c) => (/ from /.test(c) ? 2 : 1)));
}

function nz(v: number): number {
  return Number.isNaN(v) ? 0 : v;
}

function reconcileCca(
  c: CcaPage,
  segs: Array<{ tou: Partial<Record<Bucket, { q: number; a: number }>>; pcia: number; ffs: number }>,
  usage: number,
): { value: Choice["cca"]; computed: string[] } | null {
  // The CCA normally credits back exactly the PCIA and FFS that PG&E billed (to the cent or one off).
  const deliveredPcia = sum(segs.map((s) => s.pcia));
  const deliveredFfs = sum(segs.map((s) => s.ffs));
  const mirror = (printed: number[], billed: number): number[] => [...printed, ...[-billed, -billed - 1, -billed + 1].filter((v) => !printed.includes(v))];
  const tou: Choice["cca"]["tou"] = {};
  const computed: string[] = [];
  let missing: { b: Bucket; q: number } | null = null;
  for (const b of TOU_BUCKETS) {
    const line = c.lines[b];
    const q = sum(segs.map((s) => s.tou[b]?.q ?? 0));
    if (!line) {
      if (q > 0) {
        // An unread CCA line: its amount is solved from Net Charges below (at most one).
        if (missing) return null;
        missing = { b, q };
      }
      continue;
    }
    if (line.rate == null) {
      if (line.amount.length !== 1) return null;
      tou[b] = { q, a: line.amount[0]! };
      computed.push(`cca ${b} rate`);
      continue;
    }
    const a = r2((q / MICRO) * line.rate * 100);
    if (!line.amount.includes(a)) computed.push(`cca ${b}`);
    tou[b] = { q, a };
  }
  const gross = sum(Object.values(tou).map((v) => v!.a));
  const best: Array<{ value: Choice["cca"]; computed: string[] }> = [];
  // NaN = "misread": solved from the other values (at most one per equation).
  const pick = (values: number[]): number[] => [...values, NaN];
  for (const pcia of pick(mirror(c.pcia, deliveredPcia)))
    for (const ffs of pick(mirror(c.ffs, deliveredFfs)))
      for (const prod of pick(c.productAmount))
        for (const net of pick(c.net))
          for (const ect of pick(c.ect))
            for (const total of pick(c.total)) {
              const comp = [...computed];
              const parts = [pcia, ffs, prod];
              const unknownParts = parts.filter((v) => Number.isNaN(v)).length;
              let n = net;
              let p = [...parts];
              let lines = tou;
              if (missing) {
                if (unknownParts > 0 || Number.isNaN(n)) continue;
                const a = n - gross - sum(p);
                const implied = a / 100 / (missing.q / MICRO);
                if (!(implied > 0.01 && implied < 1)) continue;
                lines = { ...tou, [missing.b]: { q: missing.q, a } };
                comp.push(`cca ${missing.b} line from net`);
              } else if (Number.isNaN(n)) {
                if (unknownParts > 0 || Number.isNaN(total)) continue;
                n = gross + sum(p);
                comp.push("cca net");
              } else if (unknownParts === 1) {
                const at = p.findIndex((v) => Number.isNaN(v));
                p[at] = n - gross - sum(p.filter((v) => !Number.isNaN(v)));
                comp.push(`cca ${["pcia", "ffs", "product"][at]} from net`);
              } else if (unknownParts > 1) continue;
              const g = sum(Object.values(lines).map((v) => v!.a));
              // The CCA rounds Net Charges from unrounded lines: allow one cent.
              if (Math.abs(g + sum(p) - n) > 1) continue;
              if (Math.abs(p[2]!) > g * 0.1) continue; // a product discount or premium is a few percent
              if (!Number.isNaN(pcia) && !c.pcia.includes(pcia)) comp.push("cca pcia mirrors PG&E");
              if (!Number.isNaN(ffs) && !c.ffs.includes(ffs)) comp.push("cca ffs mirrors PG&E");
              const uut = r2(n * (c.uutRate ?? 0.05));
              if (c.uut.length && !c.uut.includes(uut)) comp.push("cca uut");
              let e = ect;
              let t = total;
              if (Number.isNaN(e) && Number.isNaN(t)) continue;
              if (Number.isNaN(e)) {
                e = t - n - uut;
                comp.push("cca ect from total");
              }
              if (Number.isNaN(t)) {
                t = n + uut + e;
                comp.push("cca total");
              }
              if (n + uut + e !== t) continue;
              if (e < 0 || e > Math.ceil((usage / MICRO) * 0.01 * 100)) continue; // ECT is a fraction of a cent per kWh
              best.push({ value: { tou: lines, pcia: p[0]!, ffs: p[1]!, prod: p[2]!, net: n, uut, ect: e, total: t }, computed: comp });
            }
  const offMirror = (v: Choice["cca"]): number => Number(Math.abs(v.pcia + deliveredPcia) > 1) + Number(Math.abs(v.ffs + deliveredFfs) > 1);
  const netGap = (v: Choice["cca"]): number => Math.abs(sum(Object.values(v.tou).map((x) => x!.a)) + v.pcia + v.ffs + v.prod - v.net) / 2;
  const score = (x: { value: Choice["cca"]; computed: string[] }): number => cost(x.computed) + 2 * offMirror(x.value) + netGap(x.value);
  best.sort((a, b) => score(a) - score(b));
  return best[0] ?? null;
}

function* product<T>(lists: T[][]): Generator<T[]> {
  if (lists.length === 0) {
    yield [];
    return;
  }
  const [head, ...rest] = lists;
  for (const item of head!) for (const tail of product(rest)) yield [item, ...tail];
}

// ---------- rows ----------

function centsStr(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function microStr(micro: number): string {
  const whole = Math.floor(micro / MICRO);
  const frac = String(micro % MICRO).padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

function vote(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = "";
  let n = 0;
  for (const [v, c] of counts) if (c > n) [best, n] = [v, c];
  return best;
}

/**
 * The most common copy when it is clearly ahead: at least 3 copies and at least twice the runner-up.
 * Otherwise "" (the caller sends the rows to needs_review).
 */
function majority(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  const [first, second] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!first || first[1] < 3) return "";
  return first[1] >= 2 * (second?.[1] ?? 0) ? first[0] : "";
}

interface Identity {
  account: string;
  sa: string;
  /** Every copy of the PG&E service agreement ID that was read, for the review note. */
  saCopies: string[];
  meter: string;
  street: string;
  city: string;
}

function identity(pages: string[]): Identity {
  const accounts: string[] = [];
  const sas: string[] = [];
  const meters: string[] = [];
  const streets: string[] = [];
  for (const page of pages) {
    for (const m of page.matchAll(/Account\s*No\W{0,4}\s*(\d{10})\s*-?\s*(\d)\b/gi)) accounts.push(`${m[1]}-${m[2]}`);
    const delivery = /Delivery\s+Charges/i.test(page);
    // The PG&E service agreement ID is printed on each delivery page and again on the CCA page as the
    // "ESP Customer Number" (the CCA page's own "Service Agreement ID" is the CCA's, not PG&E's).
    if (delivery) for (const m of page.matchAll(/Agreement\s*[I1l][D)]\W{0,3}\s*(\d{10})\b/gi)) sas.push(m[1]!);
    for (const m of page.matchAll(/ESP\s*Customer\s*N\w*\W{0,3}\s*(\d{10})\b/gi)) sas.push(m[1]!);
    for (const m of page.matchAll(/Me[te]{2}r\s*#\W{0,6}(\d{10})\b/gi)) meters.push(m[1]!);
    for (const m of page.matchAll(/Service\s+For\W{0,3}\s*(\d{1,6}\s+[A-Z][A-Z ]+?(?:\s(?:CT|ST|AVE|RD|DR|BLVD|WAY|LN|PL|CIR))\b)/g)) streets.push(m[1]!.replace(/\s+/g, " "));
  }
  const city = pages.some((p) => /Union\s*City\s*Utility/i.test(p)) ? "UNION CITY" : "";
  return { account: vote(accounts), sa: majority(sas), saCopies: sas, meter: vote(meters), street: vote(streets), city };
}

export function parsePgeBills(text: string, sourceFile: string): BillDraft[] {
  const pages = text.split(PAGE_BREAK);
  const id = identity(pages);
  const rows: BillDraft[] = [];
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i] ?? "";
    if (!/Electric\s+Delivery\s+Charges/i.test(page) || !/Customer\s*Charge/i.test(page)) continue;
    const delivery = parseDelivery(page);
    const next = pages[i + 1] ?? "";
    const cca = /Generation\s+Charges/i.test(next) && !/Electric\s+Delivery\s+Charges/i.test(next.slice(0, 600)) ? parseCca(next) : null;
    const period = delivery.period ?? cca?.period ?? null;
    if (!period) continue;
    rows.push(buildRow(delivery, cca, period, id, sourceFile, next));
  }
  return rows;
}

function buildRow(
  d: DeliveryPage,
  c: CcaPage | null,
  period: { start: string; end: string; days: number },
  id: Identity,
  sourceFile: string,
  ccaText: string,
): BillDraft {
  const row = emptyBill(sourceFile);
  row.utility = "Pacific Gas and Electric";
  row.parser_id = PGE_PARSER_ID;
  row.customer_account = id.account;
  row.service_account = id.sa;
  row.meter_id = id.meter;
  row.service_address = id.street;
  row.service_city = id.city;
  row.service_state = "CA";
  row.rate_schedule = d.rateSchedule;
  row.billing_period_start = period.start;
  row.billing_period_end = period.end;
  row.billing_days = String(period.days);
  row.bill_prepared_date = d.statementDate || labeledDate(ccaText, /Sta\w*\s*Date/i);
  row.due_date = d.dueDate || labeledDate(ccaText, /Due\s*Date/i);
  const notes: string[] = [];
  const reconciled = reconcile(d, c, period.days);
  const { choice } = reconciled;
  let { reason } = reconciled;
  if (!id.sa) {
    const seen = [...new Set(id.saCopies)].map((v) => `${v} x${id.saCopies.filter((x) => x === v).length}`).join(", ");
    reason = `service agreement ID has no clear leader across pages (${seen || "none read"})${choice ? "" : `; ${reason}`}`;
  }
  if (!c) notes.push("no generation page for this period");
  if (!choice || !id.sa) {
    row.parse_confidence = "0.25";
    row.notes = [`needs_review: ${reason}`, ...notes].join("; ");
    return row;
  }
  const items: Array<ChargeLine & { provider: string }> = [];
  const add = (provider: string, label: string, cents: number, category: ChargeCategory): void => {
    items.push({ label, amount_usd: centsStr(cents), category, provider });
  };
  const buckets: Partial<Record<Bucket, number>> = {};
  let kwMax = 0;
  const multi = choice.delivery.segs.length > 1;
  for (const [index, s] of choice.delivery.segs.entries()) {
    const segTag = multi ? ` (part ${index + 1}, ${s.days} days)` : "";
    const raw = d.segments[index]!;
    add("PG&E", `Customer Charge ${s.days} days @ $${raw.customer?.rate?.toFixed(5)}${segTag}`, s.cust, "fee");
    add("PG&E", `Demand Charge ${microStr(s.kw)} kW @ $${raw.demand?.rate?.toFixed(5)}${segTag}`, s.dem, "demand");
    kwMax = Math.max(kwMax, s.kw);
    for (const b of TOU_BUCKETS) {
      const t = s.tou[b];
      if (!t) continue;
      buckets[b] = (buckets[b] ?? 0) + t.q;
      add("PG&E", `${label(b)} ${microStr(t.q)} kWh @ $${raw.tou[b]?.rate?.toFixed(5) ?? "?"}${segTag}`, t.a, "energy");
    }
    add("PG&E", `Generation Credit${segTag}`, s.gen, "energy");
    add("PG&E", `Power Charge Indifference Adjustment${segTag}`, s.pcia, "fee");
    add("PG&E", `Franchise Fee Surcharge${segTag}`, s.ffs, "fee");
    add("PG&E", `Utility Users' Tax${segTag}`, s.uut, "tax");
  }
  if (c) {
    const provider = c.provider || "CCA";
    for (const b of TOU_BUCKETS) {
      const t = choice.cca.tou[b];
      if (!t) continue;
      add(provider, `${label(b)} ${c.lines[b]?.season ?? ""} ${microStr(t.q)} kWh @ $${c.lines[b]?.rate?.toFixed(5) ?? "?"}`.replace(/\s+/g, " "), t.a, "energy");
    }
    add(provider, "Power Charge Indifference Adjustment Credit", choice.cca.pcia, "fee");
    add(provider, "Franchise Fee Surcharge Credit", choice.cca.ffs, "fee");
    add(provider, c.product ? `${c.product} adjustment` : "Product adjustment", choice.cca.prod, "energy");
    add(provider, "Local Utility Users Tax", choice.cca.uut, "tax");
    add(provider, "Energy Commission Tax", choice.cca.ect, "tax");
  }
  const cat = (k: ChargeCategory): number => sum(items.filter((i) => i.category === k).map((i) => Math.round(Number(i.amount_usd) * 100)));
  const total = choice.delivery.total + (c ? choice.cca.total : 0);
  row.kwh_total = microStr(choice.delivery.usage);
  for (const b of TOU_BUCKETS) if (buckets[b] != null) row[BUCKET_COLUMN[b]] = microStr(buckets[b]!);
  row.demand_kw_max = microStr(kwMax);
  row.energy_charges_usd = centsStr(cat("energy"));
  row.demand_charges_usd = centsStr(cat("demand"));
  row.taxes_usd = centsStr(cat("tax"));
  row.fees_usd = centsStr(cat("fee"));
  row.other_charges_usd = centsStr(total - cat("energy") - cat("demand") - cat("tax") - cat("fee"));
  row.electric_total_usd = centsStr(total);
  row.total_new_charges_usd = centsStr(total);
  row.amount_due_usd = centsStr(total);
  row.line_items_json = JSON.stringify(items);
  notes.push(`delivery ${centsStr(choice.delivery.total)} + generation ${c ? centsStr(choice.cca.total) : "0.00"}`);
  if (c) notes.push(`generation: ${c.provider || "CCA"} ${c.product}`.trim());
  if (multi) notes.push(`rates change mid-period; ${choice.delivery.segs.length} rate segments`);
  notes.push("amount_due is this period's delivery + generation (statement pages only, no account summary)");
  if (choice.computed.length) notes.push(`recomputed from quantity x rate or totals: ${choice.computed.join(", ")}`);
  row.parse_confidence = choice.computed.length ? "0.90" : "1.00";
  row.notes = notes.join("; ");
  return row;
}

function label(b: Bucket): string {
  return { peak: "Peak", part_peak: "Part Peak", off_peak: "Off Peak", super_off_peak: "Super Off Peak" }[b];
}
/** Test-only access to the stages. */
export const __pgeInternals = { parseDelivery, parseCca, reconcile, lineOptions, flatRate, majority };
