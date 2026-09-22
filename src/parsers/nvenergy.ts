import { emptyBill, type BillDraft, type BillParser } from "./base";
import type { ChargeCategory, ChargeLine } from "./charges";

export const NV_ENERGY_PARSER_ID = "nv_energy_lgs1_layout_v1";

const KWH_PERIOD =
  /KWH\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+to\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d+)\s+[\d,]+\s+[\d,]+\s+\d+\s+([\d,]+)/i;

const METERED_CHARGE =
  /^([A-Za-z][^$\n]*?)\s+([\d,]+\.\d+)\s+(kWh|kW)\s+x\s+[\d.]+(\s+CR)?\s+\$([\d,]+\.\d{2})(\s*CR)?/i;

const FLAT_CHARGE = /^(Basic Service Charge|Local Government Fee)\b.*\$([\d,]+\.\d{2})(\s*CR)?/i;

const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

function normalizeText(text: string): string {
  return text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\f", "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
}

function first(pattern: RegExp, text: string): string | undefined {
  const match = pattern.exec(text);
  if (!match) return undefined;
  return (match[1] ?? match[0]).trim();
}

function money(value: string | undefined): string {
  if (!value) return "";
  return value.replaceAll(",", "").replaceAll("$", "").trim();
}

function plainNumber(value: string | undefined): string {
  if (!value) return "";
  return value.replaceAll(",", "").trim();
}

function toIso(mdy: string): string {
  const [month, day, yearPart] = mdy.split("/");
  let year = Number(yearPart);
  if (year < 100) year += 2000;
  return `${String(year).padStart(4, "0")}-${String(Number(month)).padStart(2, "0")}-${String(Number(day)).padStart(2, "0")}`;
}

function longToIso(value: string): string {
  const match = /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/.exec(value.trim());
  if (!match) return "";
  const month = MONTHS[(match[1] ?? "").slice(0, 3).toLowerCase()];
  if (!month) return "";
  return `${match[3]}-${month}-${String(Number(match[2])).padStart(2, "0")}`;
}

function toCents(value: string): number {
  if (!value.trim()) return 0;
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100);
}

function fromCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * Where this statement starts. PAGE 1 OF is the statement header. A payment stub that
 * sits after the previous bill's last page, and not on that page's charge total, belongs here.
 */
function statementStart(text: string, page1At: number): number {
  const before = text.slice(0, page1At);
  const pages = [...before.matchAll(/PAGE\s+\d+\s+OF\s+\d+/gi)];
  const last = pages.at(-1);
  if (!last || last.index === undefined) return 0;
  const gapStart = last.index + last[0].length;
  const gap = text.slice(gapStart, page1At);
  if (!/Total Electric Service Amount/i.test(gap) && !/KWH\s+\d{1,2}\//i.test(gap)) return gapStart;

  const totals = [...gap.matchAll(/Total Electric Service Amount/gi)];
  const lastTotal = totals.at(-1);
  if (!lastTotal || lastTotal.index === undefined) return page1At;
  const afterTotal = gap.slice(lastTotal.index);
  const coupon = /Account Number:/i.exec(afterTotal);
  if (!coupon || coupon.index === undefined) return page1At;
  return gapStart + lastTotal.index + coupon.index;
}

/** One slice per statement. Each slice keeps that period's charges and payment stub. */
function splitOnPage1(text: string): string[] {
  const markers = [...text.matchAll(/PAGE\s+1\s+OF\s+\d+/gi)];
  if (markers.length === 0) return [text];
  const starts = markers.map((marker) => statementStart(text, marker.index ?? 0));
  const slices = starts.map((start, index) => text.slice(start, starts[index + 1] ?? text.length).trim());
  const withPeriod = slices.filter((slice) => new RegExp(KWH_PERIOD.source, "i").test(slice));
  return withPeriod.length > 0 ? withPeriod : slices;
}

/** One slice per KWH service period when a file has no PAGE 1 OF markers. */
function splitByKwhPeriods(text: string): string[] {
  const marks = [...text.matchAll(new RegExp(KWH_PERIOD.source, "gi"))];
  if (marks.length <= 1) return [text];
  const starts = marks.map((mark, index) => {
    const kwhAt = mark.index ?? 0;
    const previous = index === 0 ? -1 : (marks[index - 1]?.index ?? -1);
    const meterAt = text.lastIndexOf("Meter Number:", kwhAt);
    return meterAt > previous ? meterAt : kwhAt;
  });
  const header = text.slice(0, starts[0] ?? 0);
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? text.length;
    return `${header}\n${text.slice(start, end)}`.trim();
  });
}

function statementPieces(text: string): string[] {
  return splitOnPage1(text).flatMap((statement) => splitByKwhPeriods(statement));
}

function normalizeRate(value: string): string {
  return value.replace(/\s*-\s*/g, " - ").replace(/\s+/g, " ").trim();
}

function parseIdentity(text: string): Pick<
  BillDraft,
  "customer_name" | "service_address" | "service_city" | "service_state" | "service_zip"
> {
  const empty = {
    customer_name: "",
    service_address: "",
    service_city: "",
    service_state: "",
    service_zip: "",
  };
  const block =
    /(?:^|\n)([A-Z0-9][A-Z0-9 .,&'/-]{2,})\n+(\d+[^\n]+)\n+([A-Z][A-Z .'-]+),\s*([A-Z]{2})\s+(\d{5})\b/.exec(
      text,
    );
  const service = /Service Address:\s*(\d+[^\n]+)\n+([A-Z][A-Z .'-]+),\s*([A-Z]{2})\s+(\d{5})\b/.exec(text);
  if (!block && !service) return empty;
  return {
    customer_name: (block?.[1] ?? "").trim(),
    service_address: (service?.[1] ?? block?.[2] ?? "").trim(),
    service_city: (service?.[2] ?? block?.[3] ?? "").trim(),
    service_state: (service?.[3] ?? block?.[4] ?? "").trim(),
    service_zip: (service?.[4] ?? block?.[5] ?? "").trim(),
  };
}

function chargeRegion(text: string): string {
  const start = text.search(/\bCharge Details\b/i);
  if (start < 0) return text;
  const rest = text.slice(start);
  const end = /\bTotal Electric Service Amount\b/i.exec(rest);
  return end?.index !== undefined ? rest.slice(0, end.index) : rest;
}

function categoryFor(label: string): ChargeCategory {
  if (/\btax\b/i.test(label)) return "tax";
  if (/^demand charge\b/i.test(label)) return "demand";
  if (/^electric consumption\b/i.test(label) || /^deferred energy adjustment\b/i.test(label)) return "energy";
  return "fee";
}

function signedAmount(raw: string, credit: boolean): string {
  const amount = money(raw);
  if (!amount) return "";
  return credit ? `-${amount}` : amount;
}

function parseChargeLines(text: string): ChargeLine[] {
  const lines: ChargeLine[] = [];
  for (const raw of chargeRegion(text).split("\n")) {
    const line = raw.trim();
    if (!line || !line.includes("$")) continue;
    const metered = METERED_CHARGE.exec(line);
    if (metered) {
      const label = (metered[1] ?? "").replace(/\s+/g, " ").trim();
      const credit = Boolean(metered[4] || metered[6]);
      const amount = signedAmount(metered[5] ?? "", credit);
      if (label && amount) lines.push({ label, amount_usd: amount, category: categoryFor(label) });
      continue;
    }
    const flat = FLAT_CHARGE.exec(line);
    if (!flat) continue;
    const label = (flat[1] ?? "").replace(/\s+/g, " ").trim();
    const amount = signedAmount(flat[2] ?? "", Boolean(flat[3]));
    if (label && amount) lines.push({ label, amount_usd: amount, category: categoryFor(label) });
  }
  return lines;
}

/** Plain "Demand Charge" kW. Prior/new rate splits are not a single demand reading. */
function demandKw(text: string): string {
  const match = /(?:^|\n)Demand Charge\s+([\d,]+\.\d+)\s+kW\b/i.exec(text);
  return match ? plainNumber(match[1]) : "";
}

function sumCategory(items: readonly ChargeLine[], category: ChargeCategory): number {
  return items.filter((item) => item.category === category).reduce((total, item) => total + toCents(item.amount_usd), 0);
}

function applyCharges(row: BillDraft, text: string, notes: string[]): void {
  const items = parseChargeLines(text);
  row.line_items_json = JSON.stringify(items);
  if (items.length === 0) return;

  const energy = sumCategory(items, "energy");
  const demand = sumCategory(items, "demand");
  const taxes = sumCategory(items, "tax");
  const fees = sumCategory(items, "fee");
  row.energy_charges_usd = fromCents(energy);
  row.demand_charges_usd = fromCents(demand);
  row.taxes_usd = fromCents(taxes);
  row.fees_usd = fromCents(fees);

  if (!row.total_new_charges_usd) return;
  const residual = toCents(row.total_new_charges_usd) - energy - demand - taxes - fees;
  row.other_charges_usd = fromCents(residual);
  if (Math.abs(residual) > 2) notes.push("charge lines do not sum to total electric service amount");
}

function amountDue(text: string): { total: string; due: string } {
  const totalLine = first(/Total Electric Service Amount\s+\$([\d,]+\.\d{2})/i, text);
  const current = first(/Current Amount Due\s+\$([\d,]+\.\d{2})/i, text);
  const summary = first(/(?:^|\n)Electric Charges\s+\$([\d,]+\.\d{2})/i, text);
  const total = money(totalLine ?? current ?? summary);
  if (total) return { total, due: total };

  const dueAt = text.search(/Amount Due By:/i);
  if (dueAt < 0) return { total: "", due: "" };
  const nearby = /\$([\d,]+\.\d{2})/.exec(text.slice(dueAt, dueAt + 600));
  const due = money(nearby?.[1]);
  return { total: "", due };
}

export function parseNvEnergyStatement(text: string, sourceFile: string, multi: boolean): BillDraft {
  const row = emptyBill(sourceFile);
  const notes: string[] = [];
  row.utility = "NV Energy";
  row.parser_id = NV_ENERGY_PARSER_ID;

  const identity = parseIdentity(text);
  row.customer_name = identity.customer_name;
  row.service_address = identity.service_address;
  row.service_city = identity.service_city;
  row.service_state = identity.service_state;
  row.service_zip = identity.service_zip;

  row.customer_account =
    first(/Account(?:\s+Number)?:\s*(\d{10,})/i, text) ?? "";
  row.service_account = first(/Premises Number:\s*(\d+)/i, text) ?? "";
  row.meter_id = first(/Meter Number:\s*([A-Za-z0-9]+)/i, text) ?? "";

  const rate = first(/Electric Usage:\s*([A-Z0-9]+(?:\s*-\s*[A-Z0-9]+)?)/i, text);
  row.rate_schedule = rate ? normalizeRate(rate) : "";

  const period = new RegExp(KWH_PERIOD.source, "i").exec(text);
  if (period) {
    row.billing_period_start = toIso(period[1] ?? "");
    row.billing_period_end = toIso(period[2] ?? "");
    row.billing_days = period[3] ?? "";
    row.kwh_total = plainNumber(period[4]);
  } else {
    notes.push("missing billing_period");
  }

  // LGS-1 is not time-of-use. Peak buckets stay blank; all kWh stays on kwh_total.
  row.demand_kw_max = demandKw(text);
  if (!row.demand_kw_max) notes.push("no single Demand Charge kW");

  const amounts = amountDue(text);
  row.total_new_charges_usd = amounts.total;
  row.amount_due_usd = amounts.due;
  if (!row.amount_due_usd) notes.push("missing amount_due");

  const due = first(/Amount Due By:\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})/i, text);
  if (due) row.due_date = longToIso(due);
  const billed = first(/Billing Date:\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})/i, text);
  if (billed) row.bill_prepared_date = longToIso(billed);

  applyCharges(row, text, notes);

  if (multi) notes.push("multi-statement pdf; row is this billing period only");
  notes.push("non-TOU; usage in kwh_total");

  const required = [
    "customer_account",
    "amount_due_usd",
    "kwh_total",
    "billing_period_start",
    "billing_period_end",
  ] as const;
  const missingReq = required.filter((field) => !row[field]);
  if (missingReq.length > 0) notes.push(`MISSING_REQUIRED:${missingReq.join(",")}`);

  let confidence = 1;
  confidence -= 0.25 * missingReq.length;
  if (notes.some((note) => note.startsWith("charge lines do not sum"))) confidence -= 0.1;
  confidence = Math.max(0, Math.min(1, Math.round(confidence * 100) / 100));
  row.parse_confidence = confidence.toFixed(2);
  row.notes = notes.join("; ");
  return row;
}

export function parseNvEnergyBills(text: string, sourceFile: string): BillDraft[] {
  const pieces = statementPieces(normalizeText(text));
  const multi = pieces.length > 1;
  const rows = pieces.map((piece) => parseNvEnergyStatement(piece, sourceFile, multi));
  return rows.sort(
    (a, b) =>
      a.billing_period_start.localeCompare(b.billing_period_start) ||
      a.billing_period_end.localeCompare(b.billing_period_end),
  );
}

export const nvEnergyParser: BillParser = {
  id: NV_ENERGY_PARSER_ID,
  match(text: string): boolean {
    const source = normalizeText(text);
    return /\bNV\s*Energy\b/i.test(source) || /nvenergy\.com/i.test(source);
  },
  parse: parseNvEnergyBills,
};
