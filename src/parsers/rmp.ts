import { emptyBill, type BillDraft, type BillParser } from "./base";
import type { ChargeCategory, ChargeLine } from "./charges";

export const RMP_PARSER_ID = "rocky_mountain_power_v1";

const NEW_CHARGES = /(?<!Total )New Charges[^\d\n]{0,8}([\d,]+\.\d{2})/gi;
const BILLING_DATE = /BILLING DATE:\s*([A-Za-z]+ \d{1,2}, \d{4})/gi;
const DUE_DATE = /(?:DUE DATE|Date Due):\s*([A-Za-z]+ \d{1,2}, \d{4})/gi;
const DATE_IN_LINE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s+(\d{4})\b/g;

const MONTH_TYPO: Record<string, string> = {
  feh: "Feb",
  fab: "Feb",
  fah: "Feb",
  fep: "Feb",
  fev: "Feb",
  war: "Mar",
};

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

function canonDateToken(full: string, mon: string, day: string, year: string): string {
  const key = mon.slice(0, 3).toLowerCase();
  const name = MONTH_TYPO[key] ?? (MONTHS[key] ? mon.slice(0, 1).toUpperCase() + mon.slice(1, 3).toLowerCase() : "");
  if (!name || !MONTHS[name.slice(0, 3).toLowerCase()]) return full;
  return `${name} ${Number(day)}, ${year}`;
}

/** Glue OCR dates (`Jan9,2025`, `Feh 10, 2025`) into `Jan 9, 2025`. */
function normalizeOcrText(text: string): string {
  return text.replace(/\b([A-Za-z]{3,9})\.?\s*(\d{1,2}),?\s*(\d{4})\b/g, (full, mon: string, day: string, year: string) =>
    canonDateToken(full, mon, day, year),
  );
}

function elapsedDays(startIso: string, endIso: string): string {
  const start = Date.parse(`${startIso}T00:00:00Z`);
  const end = Date.parse(`${endIso}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return "";
  const days = Math.round((end - start) / 86_400_000);
  return days > 0 && days < 400 ? String(days) : "";
}

function dateLabel(match: RegExpMatchArray): string {
  return `${match[1]} ${Number(match[2])}, ${match[3]}`;
}

function findDates(line: string): RegExpMatchArray[] {
  return [...line.matchAll(new RegExp(DATE_IN_LINE.source, "g"))];
}

function kwhAmount(raw: string): string {
  const token = raw.trim();
  if (/^\d{1,3}\.\d{3}$/.test(token)) return token.replace(".", "");
  return plainNumber(token);
}

function parseUsageLine(line: string): Omit<UsageHit, "index" | "end"> | null {
  if (!/kwh/i.test(line)) return null;
  if (/\benergy charge\b/i.test(line) || /\bkvarh\b/i.test(line)) return null;
  const meter = /\b(\d{6,12})\b/.exec(line)?.[1];
  const dates = findDates(line);
  const start = dates[0];
  const end = dates[1];
  const kwhMatch = /([\d,]+\.\d{3}|[\d,]+)\s*kwh/i.exec(line);
  if (!meter || !start || !end || start.index === undefined || end.index === undefined || !kwhMatch || kwhMatch.index === undefined) {
    return null;
  }
  const between = line.slice(end.index + end[0].length, kwhMatch.index);
  const printedDays = [...between.matchAll(/\b(\d{1,2})\b/g)]
    .map((match) => Number(match[1]))
    .find((value) => value >= 1 && value <= 45);
  const startLabel = dateLabel(start);
  const endLabel = dateLabel(end);
  return {
    meter,
    startLabel,
    endLabel,
    days: printedDays ? String(printedDays) : elapsedDays(longToIso(startLabel), longToIso(endLabel)),
    kwh: kwhAmount(kwhMatch[1] ?? ""),
  };
}

function lastGroup(pattern: RegExp, text: string): string {
  const matches = [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))];
  const last = matches.at(-1);
  return (last?.[1] ?? "").trim();
}

function usageHits(text: string): UsageHit[] {
  const hits: UsageHit[] = [];
  let cursor = 0;
  for (const line of text.split("\n")) {
    const parsed = parseUsageLine(line);
    if (parsed) hits.push({ ...parsed, index: cursor, end: cursor + line.length });
    cursor += line.length + 1;
  }
  return hits;
}

function demandKw(text: string, meter: string, endLabel: string): string {
  const wanted = endLabel.toLowerCase();
  for (const line of text.split("\n")) {
    if (!/\bdemand\b/i.test(line) || /\bdemand charge\b/i.test(line) || !/\bkw\b/i.test(line)) continue;
    if ((/\b(\d{6,12})\b/.exec(line)?.[1] ?? "") !== meter) continue;
    const date = findDates(line)[0];
    if (!date || dateLabel(date).toLowerCase() !== wanted) continue;
    const kw = /\b(\d{1,4})\s*kw\b/i.exec(line)?.[1];
    if (kw) return plainNumber(kw);
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
    /ACCOUNT NUMBER:\s*([\d-]+(?:[ \t]+\d+)?)/i.exec(text)?.[1] ??
    /Account #[ \t]*([\d \t-]+)/i.exec(text)?.[1];
  const block =
    /(?:^|\n)([A-Z0-9][A-Z0-9 &',.-]{2,})\n+(\d+[^\n]+)\n+([A-Z][A-Z .'-]+?)\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/.exec(
      text,
    );
  const rehab = /\b((?:[A-Z][A-Z&'.-]*\s+){1,6}REHAB AND NURSING)\b/.exec(text);
  const highland = /\b(\d{3,5})\s+S\.?\s+([A-Za-z]+)\s+(?:DR|DRIVE)\.?\s+([A-Za-z]+)\s+UT\b/i.exec(text);
  const fromBlock = Boolean(block?.[1] && block?.[2]);
  const zipNearService = highland
    ? /\bUT\s+(\d{5}(?:-\d{4})?)/i.exec(text.slice(highland.index ?? 0))?.[1]
    : undefined;
  return {
    customer_name: (fromBlock ? (block?.[1] ?? "") : (rehab?.[1] ?? "")).trim(),
    customer_account: account ? normalizeAccount(account) : "",
    service_address: fromBlock ? (block?.[2] ?? "").trim() : highland ? `${highland[1]} S ${(highland[2] ?? "").toUpperCase()} DR` : "",
    service_city: fromBlock ? (block?.[3] ?? "").trim() : (highland?.[3] ?? "").toUpperCase(),
    service_state: fromBlock ? (block?.[4] ?? "").trim() : highland ? "UT" : "",
    service_zip: fromBlock ? (block?.[5] ?? "").trim() : (zipNearService ?? ""),
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

const PAGE_MARK = "\n----- PAGE -----\n";

/** One scanned page is one statement. Text PDFs have no page mark, so the window is the whole file. */
function statementWindow(text: string, hit: UsageHit): { before: string; after: string } {
  const prev = text.lastIndexOf(PAGE_MARK, hit.index);
  const start = prev === -1 ? 0 : prev + PAGE_MARK.length;
  const next = text.indexOf(PAGE_MARK, hit.end);
  const end = next === -1 ? text.length : next;
  return { before: text.slice(start, hit.index), after: text.slice(hit.end, end) };
}

function rateSchedule(beforeUsage: string): string {
  const schedules = [...beforeUsage.matchAll(/Schedule[ \t]+(\d+[A-Za-z]?)/gi)];
  return schedules.at(-1)?.[1] ?? "";
}

function statementDate(before: string, after: string, pattern: RegExp): string {
  const prior = longToIso(lastGroup(pattern, before));
  if (prior) return prior;
  const page = after.split(/\n----- PAGE -----\n/)[0] ?? after;
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const match = [...page.matchAll(new RegExp(pattern.source, flags))][0];
  return longToIso(match?.[1] ?? "");
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

  const window = statementWindow(text, hit);
  const before = window.before;
  const after = window.after;
  row.rate_schedule = rateSchedule(before) || rateSchedule(text.slice(0, hit.index));
  row.demand_kw_max = demandKw(after, hit.meter, hit.endLabel);
  row.bill_prepared_date = statementDate(before, after, BILLING_DATE);
  row.due_date = statementDate(before, after, DUE_DATE);

  // Period cost is New Charges. An Equal Payment Plan "Amount Due" is the installment, not usage cost.
  // Current Account Balance includes past due and is not the period total.
  const charges = money(lastGroup(NEW_CHARGES, before));
  row.total_new_charges_usd = charges;
  row.amount_due_usd = charges;
  applyCharges(row, chargeLines(after));

  if (!row.demand_kw_max) notes.push("missing demand kw");
  if (!charges) notes.push("missing new charges");
  if (/equal payment plan|payment plan amount/i.test(before)) {
    notes.push("equal payment plan; period cost is New Charges, not the installment amount due");
  }
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
  const source = normalizeOcrText(normalizeText(text));
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
    return (
      /Rocky\s*Mountain\s*Power/i.test(source) ||
      /RockyMountainPower/i.test(source) ||
      /Rocky\s+M[a-z]+\s+Power/i.test(source) ||
      /PacifiCorp/i.test(source)
    );
  },
  parse: parseRockyMountainBills,
};
