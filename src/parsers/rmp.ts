import { emptyBill, type BillDraft, type BillParser } from "./base";
import type { ChargeCategory, ChargeLine } from "./charges";

export const RMP_PARSER_ID = "rocky_mountain_power_v1";

const KWH_LINE =
  /(\d{6,})[ \t]+([A-Za-z]+ \d{1,2}, \d{4})[ \t]+([A-Za-z]+ \d{1,2}, \d{4})[ \t]+(\d+)[ \t]+[\d,]+[ \t]+[\d,]+[ \t]+[\d.]+[ \t]+([\d,]+)[ \t]+kwh/gi;

const DEMAND_LINE =
  /(\d{6,})[ \t]+Demand[ \t]+([A-Za-z]+ \d{1,2}, \d{4})[ \t]+[\d.]+[ \t]+[\d.]+[ \t]+([\d,]+)[ \t]+kw/gi;

const NEW_CHARGES = /(?<!Total )New Charges[ \t]+\+?\$?[ \t]*([\d,]+\.\d{2})/gi;
const BILLING_DATE = /BILLING DATE:\s*([A-Za-z]+ \d{1,2}, \d{4})/gi;
const DUE_DATE = /DUE DATE:\s*([A-Za-z]+ \d{1,2}, \d{4})/gi;

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

interface UsageHit {
  meter: string;
  startLabel: string;
  endLabel: string;
  days: string;
  kwh: string;
  index: number;
  end: number;
}

function normalizeText(text: string): string {
  return text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\f", "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
}

function plainNumber(value: string | undefined): string {
  if (!value) return "";
  return value.replaceAll(",", "").trim();
}

function money(value: string | undefined): string {
  if (!value) return "";
  return value.replaceAll(",", "").replaceAll("$", "").replace(/^\+/, "").trim();
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

function lastGroup(pattern: RegExp, text: string): string {
  const matches = [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))];
  const last = matches.at(-1);
  return (last?.[1] ?? "").trim();
}

function usageHits(text: string): UsageHit[] {
  return [...text.matchAll(new RegExp(KWH_LINE.source, "gi"))].map((match) => ({
    meter: match[1] ?? "",
    startLabel: match[2] ?? "",
    endLabel: match[3] ?? "",
    days: match[4] ?? "",
    kwh: plainNumber(match[5]),
    index: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

function demandKw(text: string, meter: string, endLabel: string): string {
  for (const match of text.matchAll(new RegExp(DEMAND_LINE.source, "gi"))) {
    const sameMeter = (match[1] ?? "") === meter;
    const sameEnd = (match[2] ?? "").toLowerCase() === endLabel.toLowerCase();
    if (sameMeter && sameEnd) return plainNumber(match[3]);
  }
  return "";
}

function normalizeAccount(raw: string): string {
  return raw.replace(/\s+/g, "");
}

function parseIdentity(text: string): Pick<
  BillDraft,
  "customer_name" | "customer_account" | "service_address" | "service_city" | "service_state" | "service_zip"
> {
  const account =
    /ACCOUNT NUMBER:\s*([\d-]+(?:[ \t]+\d)?)/i.exec(text)?.[1] ??
    /Account #[ \t]*([\d \t-]+)/i.exec(text)?.[1];
  const block =
    /(?:^|\n)([A-Z0-9][A-Z0-9 &',.-]{2,})\n+(\d+[^\n]+)\n+([A-Z][A-Z .'-]+?)\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/.exec(
      text,
    );
  return {
    customer_name: (block?.[1] ?? "").trim(),
    customer_account: account ? normalizeAccount(account) : "",
    service_address: (block?.[2] ?? "").trim(),
    service_city: (block?.[3] ?? "").trim(),
    service_state: (block?.[4] ?? "").trim(),
    service_zip: (block?.[5] ?? "").trim(),
  };
}

function categoryFor(label: string): ChargeCategory {
  if (/\btax\b/i.test(label)) return "tax";
  if (/^demand charge\b/i.test(label)) return "demand";
  if (/^energy charge\b/i.test(label)) return "energy";
  return "fee";
}

function parseChargeLine(raw: string): ChargeLine | null {
  const line = raw.replace(/\s+/g, " ").trim();
  if (!line) return null;
  const amounts = [...line.matchAll(/-?[\d,]+\.\d{2}(?!\d)/g)];
  if (amounts.length !== 1) return null;
  const amount = amounts[0];
  if (!amount || amount.index === undefined) return null;
  const hasUnit = /\b(?:kwh|kw|kvarh|lamps|units)\b/i.test(line);
  const hasRate = /-?[\d,]+\.\d{3,}/.test(line);
  const named =
    /^(Basic Charge|Demand Charge|Energy Charge|Renewable Energy|Energy Balancing|Wildfire|Customer Efficiency|Elec Vehicle|Home Electric|Municipal Energy|Utah Sales|Late Payment|Level \d|for \d+)/i.test(
      line,
    );
  if (!hasUnit && !hasRate && !named) return null;
  let label = line.slice(0, amount.index);
  label = label.replace(/\s+[\d,]+\s+(?:kwh|kw|kvarh|lamps|units)\b/gi, "");
  label = label.replace(/\s+-?[\d,]+\.\d{3,}\b/g, "");
  label = label.replace(/\s+\d+\s*$/g, "");
  label = label.replace(/\s+/g, " ").trim().replace(/[-\s]+$/g, "");
  if (!/^[A-Za-z]/.test(label)) return null;
  return {
    label,
    amount_usd: money(amount[0]),
    category: categoryFor(label),
  };
}

/** Charge lines under NEW CHARGES blocks that belong to this period, before the next bill's summary. */
function chargeLines(afterUsage: string): ChargeLine[] {
  const nextSummary = /(?<!Total )New Charges[ \t]+\+?\$?[ \t]*[\d,]+\.\d{2}/i.exec(afterUsage);
  const region = nextSummary ? afterUsage.slice(0, nextSummary.index) : afterUsage;
  const parts = region.split(/NEW CHARGES[^\n]*/i).slice(1);
  const items: ChargeLine[] = [];
  for (const part of parts) {
    const totalAt = /Total New Charges/i.exec(part);
    const body = totalAt ? part.slice(0, totalAt.index) : part;
    for (const raw of body.split("\n")) {
      const item = parseChargeLine(raw);
      if (item) items.push(item);
    }
  }
  return items;
}

function sumCategory(items: readonly ChargeLine[], category: ChargeCategory): number {
  return items.filter((item) => item.category === category).reduce((total, item) => total + toCents(item.amount_usd), 0);
}

function applyCharges(row: BillDraft, items: ChargeLine[]): void {
  row.line_items_json = JSON.stringify(items);
  if (items.length === 0 || !row.total_new_charges_usd) return;
  const energy = sumCategory(items, "energy");
  const demand = sumCategory(items, "demand");
  const taxes = sumCategory(items, "tax");
  const fees = sumCategory(items, "fee");
  row.energy_charges_usd = fromCents(energy);
  row.demand_charges_usd = fromCents(demand);
  row.taxes_usd = fromCents(taxes);
  row.fees_usd = fromCents(fees);
  const residual = toCents(row.total_new_charges_usd) - energy - demand - taxes - fees;
  row.other_charges_usd = fromCents(residual);
}

function rateSchedule(beforeUsage: string): string {
  const schedules = [...beforeUsage.matchAll(/Schedule[ \t]+(\d+[A-Za-z]?)/gi)];
  const last = schedules.at(-1)?.[1] ?? "";
  return last;
}

function parsePeriod(text: string, hit: UsageHit, sourceFile: string, multi: boolean, identity: ReturnType<typeof parseIdentity>): BillDraft {
  const row = emptyBill(sourceFile);
  const notes: string[] = [];
  row.utility = "Rocky Mountain Power";
  row.parser_id = RMP_PARSER_ID;
  row.customer_name = identity.customer_name;
  row.customer_account = identity.customer_account;
  row.service_address = identity.service_address;
  row.service_city = identity.service_city;
  row.service_state = identity.service_state;
  row.service_zip = identity.service_zip;
  row.meter_id = hit.meter;
  row.billing_period_start = longToIso(hit.startLabel);
  row.billing_period_end = longToIso(hit.endLabel);
  row.billing_days = hit.days;
  row.kwh_total = hit.kwh;

  const before = text.slice(0, hit.index);
  const after = text.slice(hit.end);
  row.rate_schedule = rateSchedule(before);
  row.demand_kw_max = demandKw(after, hit.meter, hit.endLabel);
  row.bill_prepared_date = longToIso(lastGroup(BILLING_DATE, before));
  row.due_date = longToIso(lastGroup(DUE_DATE, before));

  // Period cost is New Charges. Current Account Balance includes past due and is not the period total.
  const charges = money(lastGroup(NEW_CHARGES, before));
  row.total_new_charges_usd = charges;
  row.amount_due_usd = charges;
  applyCharges(row, chargeLines(after));

  if (!row.demand_kw_max) notes.push("missing demand kw");
  if (!charges) notes.push("missing new charges");
  if (multi) notes.push("multi-statement pdf; row is this service period only");
  notes.push("non-TOU; usage in kwh_total");

  const required = ["customer_account", "amount_due_usd", "kwh_total", "billing_period_start", "billing_period_end"] as const;
  const missing = required.filter((field) => !row[field]);
  if (missing.length > 0) notes.push(`MISSING_REQUIRED:${missing.join(",")}`);

  let confidence = 1;
  confidence -= 0.25 * missing.length;
  confidence = Math.max(0, Math.min(1, Math.round(confidence * 100) / 100));
  row.parse_confidence = confidence.toFixed(2);
  row.notes = notes.join("; ");
  return row;
}

export function parseRockyMountainBills(text: string, sourceFile: string): BillDraft[] {
  const source = normalizeText(text);
  const hits = usageHits(source);
  const identity = parseIdentity(source);
  const multi = hits.length > 1;
  const rows = hits.map((hit) => parsePeriod(source, hit, sourceFile, multi, identity));
  return rows.sort(
    (a, b) =>
      a.billing_period_start.localeCompare(b.billing_period_start) ||
      a.billing_period_end.localeCompare(b.billing_period_end),
  );
}

export const rockyMountainParser: BillParser = {
  id: RMP_PARSER_ID,
  match(text: string): boolean {
    const source = normalizeText(text);
    return /Rocky\s*Mountain\s*Power/i.test(source) || /RockyMountainPower\.net/i.test(source) || /PacifiCorp/i.test(source);
  },
  parse: parseRockyMountainBills,
};
