import { emptyBill, type BillDraft, type BillParser } from "./base";
import type { ChargeCategory, ChargeLine } from "./charges";

export const FPL_GSD1_PARSER_ID = "fpl-gsd1";

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

/** Charge amounts end before this. The usage-comparison block starts at column 80 on these statements. */
const LEFT_COLUMN_FALLBACK = 76;

const PERIOD =
  /For:\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+to\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+\((\d+)\s+days\)/i;

const MONEY = /[−-]?\s*\$?\s*(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}(?!\d)/g;

const RIGHT_MARK = /(?:This Month|kWh Used|Service to|Service days|kWh\/day|KEEP IN MIND|METER SUMMARY|Usage Type)/;

function normalizeText(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\f", "\n");
}

function iso(monthName: string, day: string, year: string): string {
  const month = MONTHS[monthName.slice(0, 3).toLowerCase()];
  if (!month) return "";
  return `${year}-${month}-${String(Number(day)).padStart(2, "0")}`;
}

function moneyToCents(token: string): number {
  const negative = /^[−-]/.test(token);
  const digits = token.replace(/[−\-$\s,]/g, "");
  const amount = Number(digits);
  if (!Number.isFinite(amount)) return 0;
  const cents = Math.round(amount * 100);
  return negative ? -cents : cents;
}

function fromCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function lastMoney(line: string): { cents: number; index: number } | null {
  let found: { cents: number; index: number } | null = null;
  for (const match of line.matchAll(MONEY)) {
    if (match.index === undefined) continue;
    found = { cents: moneyToCents(match[0]), index: match.index };
  }
  return found;
}

function plainUsage(line: string): string {
  const match = /([\d,]+(?:\.\d+)?)\s*$/.exec(line.trimEnd());
  if (!match) return "";
  const raw = (match[1] ?? "").replaceAll(",", "");
  if (/^\d+\.0+$/.test(raw)) return raw.slice(0, raw.indexOf("."));
  return raw;
}

function leftCut(text: string): number {
  let cut = Number.POSITIVE_INFINITY;
  for (const line of text.split("\n")) {
    const mark = RIGHT_MARK.exec(line);
    if (mark?.index !== undefined && mark.index >= 40) cut = Math.min(cut, mark.index);
  }
  return Number.isFinite(cut) ? cut : LEFT_COLUMN_FALLBACK;
}

function chargeLabel(beforeAmount: string): string {
  return beforeAmount
    .replace(/:/g, "")
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .trim();
}

function categoryFor(label: string): ChargeCategory | null {
  const name = label.toLowerCase();
  if (name === "non-fuel" || name.startsWith("non-fuel ")) return "energy";
  if (name === "fuel" || name.startsWith("fuel ")) return "energy";
  if (name === "demand" || name.startsWith("demand ")) return "demand";
  if (name.startsWith("gross receipts tax")) return "tax";
  if (
    name.startsWith("base charge") ||
    name.startsWith("on call credit") ||
    name.startsWith("late payment charge") ||
    name.startsWith("regulatory fee")
  ) {
    return "fee";
  }
  return null;
}

/**
 * Detail lines under Rate: GSD-1. The comparison block on the right of the same
 * lines is cut off. Electric service amount is a subtotal. Taxes and charges is
 * printed but is not part of Total new charges, so it stays out of the list.
 */
function chargeLines(text: string): ChargeLine[] {
  const start = text.search(/Rate:\s+GSD-1\b/i);
  if (start < 0) return [];
  const rest = text.slice(start);
  const end = /Total new charges\b/i.exec(rest);
  const block = end?.index !== undefined ? rest.slice(0, end.index) : rest;
  const cut = leftCut(text);
  const lines: ChargeLine[] = [];
  for (const raw of block.split("\n")) {
    const line = raw.slice(0, cut).trim();
    if (!line) continue;
    const amount = lastMoney(line);
    if (!amount) continue;
    const label = chargeLabel(line.slice(0, amount.index));
    const category = categoryFor(label);
    if (!label || !category) continue;
    lines.push({ label, amount_usd: fromCents(amount.cents), category });
  }
  return lines;
}

function sumCategory(items: readonly ChargeLine[], category: ChargeCategory): number {
  return items.filter((item) => item.category === category).reduce((total, item) => total + moneyToCents(item.amount_usd), 0);
}

function customerName(text: string): string {
  const head = text.split(/Here's what you owe/i)[0] ?? "";
  const line = head
    .split("\n")
    .map((row) => row.trim())
    .filter(Boolean)
    .at(-1);
  return (line ?? "").replace(/,$/, "");
}

function serviceLocation(text: string): {
  service_address: string;
  service_city: string;
  service_state: string;
  service_zip: string;
} {
  const match = /Service Address:\s*\n\s*(.+?)\s*\n\s*([^,\n]+),\s*([A-Z]{2})\s+(\d{5})/.exec(text);
  return {
    service_address: (match?.[1] ?? "").trim(),
    service_city: (match?.[2] ?? "").trim(),
    service_state: match?.[3] ?? "",
    service_zip: match?.[4] ?? "",
  };
}

function dueDate(text: string): string {
  const at = text.search(/NEW CHARGES DUE BY/i);
  if (at < 0) return "";
  const window = text.slice(Math.max(0, at - 600), at);
  const dates = [...window.matchAll(/([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/g)];
  const last = dates.at(-1);
  if (!last) return "";
  return iso(last[1] ?? "", last[2] ?? "", last[3] ?? "");
}

function labeledAmount(pattern: RegExp, text: string): string {
  const match = pattern.exec(text);
  if (!match?.[1]) return "";
  return fromCents(moneyToCents(match[1]));
}

export function parseFplGsd1Bills(text: string, sourceFile: string): BillDraft[] {
  const source = normalizeText(text);
  const row = emptyBill(sourceFile);
  row.utility = "Florida Power & Light";
  row.parser_id = FPL_GSD1_PARSER_ID;
  row.customer_name = customerName(source);
  row.customer_account = /Account Number:\s*(\d{5}-\d{5})/.exec(source)?.[1] ?? "";

  const where = serviceLocation(source);
  row.service_address = where.service_address;
  row.service_city = where.service_city;
  row.service_state = where.service_state;
  row.service_zip = where.service_zip;

  const rate = /Rate:\s+(GSD-1)\b/i.exec(source);
  row.rate_schedule = rate?.[1] ?? "";
  row.meter_id = /Meter\s+([A-Z]{1,4}\d{3,})/.exec(source)?.[1] ?? "";

  const period = PERIOD.exec(source);
  if (period) {
    row.billing_period_start = iso(period[1] ?? "", period[2] ?? "", period[3] ?? "");
    row.billing_period_end = iso(period[4] ?? "", period[5] ?? "", period[6] ?? "");
    row.billing_days = period[7] ?? "";
  }

  const kwh = source.split("\n").find((line) => /^\s*kWh used\b/.test(line));
  const demand = source.split("\n").find((line) => /\bDemand KW\b/.test(line));
  if (kwh) row.kwh_total = plainUsage(kwh.slice(kwh.search(/kWh used\b/)));
  if (demand) row.demand_kw_max = plainUsage(demand.slice(demand.search(/Demand KW\b/)));

  row.total_new_charges_usd = labeledAmount(/Total new charges\s+\$?([\d,]+\.\d{2})/i, source);
  row.amount_due_usd = labeledAmount(/Total amount you owe\s+\$([\d,]+\.\d{2})/i, source);

  const prepared = /Statement Date:\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/i.exec(source);
  if (prepared) row.bill_prepared_date = iso(prepared[1] ?? "", prepared[2] ?? "", prepared[3] ?? "");
  row.due_date = dueDate(source);

  const items = chargeLines(source);
  row.line_items_json = JSON.stringify(items);
  if (items.length > 0) {
    const energy = sumCategory(items, "energy");
    const demandCents = sumCategory(items, "demand");
    const taxes = sumCategory(items, "tax");
    const fees = sumCategory(items, "fee");
    row.energy_charges_usd = fromCents(energy);
    row.demand_charges_usd = fromCents(demandCents);
    row.taxes_usd = fromCents(taxes);
    row.fees_usd = fromCents(fees);
    if (row.total_new_charges_usd) {
      const residual = moneyToCents(row.total_new_charges_usd) - energy - demandCents - taxes - fees;
      row.other_charges_usd = fromCents(residual);
      if (residual !== 0) {
        row.notes = `needs_review: charge lines ${fromCents(energy + demandCents + taxes + fees)} != ${row.total_new_charges_usd}`;
      }
    }
  }

  row.parse_confidence = row.notes.startsWith("needs_review") ? "0.50" : "1.00";
  return [row];
}

export const fplGsd1Parser: BillParser = {
  id: FPL_GSD1_PARSER_ID,
  match(text: string): boolean {
    const source = normalizeText(text);
    const fpl = /FPL\.com/i.test(source) || /Make check payable to FPL/i.test(source);
    return fpl && /GSD-1\s+GENERAL SERVICE DEMAND/i.test(source);
  },
  parse: parseFplGsd1Bills,
};
