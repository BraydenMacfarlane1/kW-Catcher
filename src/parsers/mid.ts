import { emptyBill, type BillDraft, type BillParser } from "./base";
import type { ChargeCategory, ChargeLine } from "./charges";

export const MID_PARSER_ID = "mid-electric";

/**
 * Modesto Irrigation District (MID) commercial statements.
 *
 * A statement lists several service agreements (SA ID). Each SA has a header
 * (address, Bill Period, Rate, Total Charges, Start Date) and then its charge
 * lines. pdftotext -layout keeps each label and amount on one line. unpdf
 * prints all labels and then all amounts. Both are read the same way: labels
 * in order, amounts in order, paired by position.
 *
 * Metered SAs (GS-2, GS-1, ...) are one row each. Unmetered outdoor lighting
 * (SL2 and other SL* rates) has no meter, so its dollars ride on the first
 * metered row of the statement as non_electric_charges_usd. Rows then add up
 * to the statement Current Charges.
 */

const SA_HEADER = /SA ID:[ \t]*(\d+)[ \t]+Outage Block/g;
const BLOCK_END =
  /Lobby and Telephone Hours|PLEASE DETACH|Meter Consumption Details|Account Number:|Authorized MID Payment|Customer Service MID Charges|\[Record\*/;
const MONEY = /(-?)\$(-?)((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})(?!\d)/g;
/** A charge label is text on one line that ends with "@ $rate" or "@ N%", or one of the fixed labels. */
const LABEL = /(?:\bService Fee\b|\b[A-Z][^\n$@]*?@ (?:\$\d[\d,]*(?:\.\d+)?|\d+(?:\.\d+)?%))/g;
const DATE = /(\d{2})\/(\d{2})\/(\d{2,4})/;

interface SaBlock {
  billId: string;
  saId: string;
  address: string;
  city: string;
  rateCode: string;
  rateName: string;
  start: string;
  end: string;
  totalCents: number | null;
  items: ChargeLine[];
  /** Empty when labels and amounts paired and summed to Total Charges. */
  problem: string;
}

interface MeterInfo {
  meter: string;
  demandKw: string;
}

interface Statement {
  billId: string;
  blocks: SaBlock[];
  currentCents: number | null;
  billDate: string;
  dueDate: string;
}

function normalizeText(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\f", "\n");
}

function isoDate(value: string): string {
  const match = DATE.exec(value);
  if (!match) return "";
  const year = (match[3] ?? "").length === 2 ? `20${match[3]}` : (match[3] ?? "");
  return `${year}-${match[1]}-${match[2]}`;
}

function daysBetween(start: string, end: string): string {
  if (!start || !end) return "";
  const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
  return Number.isFinite(days) && days > 0 ? String(days) : "";
}

function toCents(sign1: string, sign2: string, digits: string): number {
  const cents = Math.round(Number(digits.replaceAll(",", "")) * 100);
  return sign1 === "-" || sign2 === "-" ? -cents : cents;
}

function fromCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function amountsIn(text: string): number[] {
  return [...text.matchAll(MONEY)].map((match) => toCents(match[1] ?? "", match[2] ?? "", match[3] ?? ""));
}

function categoryFor(label: string): ChargeCategory {
  if (/^Service Fee\b/i.test(label)) return "fee";
  if (/^City Tax\b|^State Surcharge\b|\bTax\b/i.test(label)) return "tax";
  if (/^Demand\b|\bkW @/i.test(label)) return "demand";
  if (/\bkWh\b/i.test(label)) return "energy";
  return "other";
}

function lineStart(text: string, index: number): number {
  return text.lastIndexOf("\n", index) + 1;
}

/** Block text runs from its header line to the next SA header or page furniture. */
function blockText(text: string, from: number, nextHeader: number): string {
  const slice = text.slice(from, nextHeader);
  const firstLineEnd = slice.indexOf("\n");
  const rest = firstLineEnd < 0 ? "" : slice.slice(firstLineEnd);
  const end = BLOCK_END.exec(rest);
  return end?.index !== undefined ? slice.slice(0, firstLineEnd + end.index) : slice;
}

function parseBlock(block: string, saId: string, billId: string): SaBlock {
  const sa: SaBlock = {
    billId,
    saId,
    address: "",
    city: "",
    rateCode: "",
    rateName: "",
    start: "",
    end: "",
    totalCents: null,
    items: [],
    problem: "",
  };
  const period = /Bill Period:\s*(\d{2}\/\d{2}\/\d{2,4})\s*-\s*(\d{2}\/\d{2}\/\d{2,4})/.exec(block);
  if (period) {
    sa.start = isoDate(period[1] ?? "");
    sa.end = isoDate(period[2] ?? "");
  }
  const address = /(?:^|\n)[ \t]*(\d+[ \t]+[A-Za-z0-9 .#'-]+?),[ \t]*([A-Za-z][A-Za-z .]*?)(?=[ \t]{2,}|[ \t]*\n|[ \t]*$)/.exec(block);
  if (address) {
    sa.address = (address[1] ?? "").trim();
    sa.city = (address[2] ?? "").trim();
  }
  const rate = /Rate:[ \t]*(\S+)[ \t]+(.*?)(?=[ \t]{2,}|[ \t]*\n|$)/.exec(block);
  if (rate) {
    sa.rateCode = rate[1] ?? "";
    sa.rateName = (rate[2] ?? "").replace(/\s+Total Charges.*$/, "").trim();
  }

  const startDate = /Start Date:[ \t]*\d{2}\/\d{2}\/\d{2,4}/.exec(block);
  const headerEnd = startDate?.index !== undefined ? startDate.index + startDate[0].length : -1;
  if (headerEnd < 0) {
    sa.problem = "Start Date not found";
    return sa;
  }
  const header = block.slice(0, headerEnd);
  const totalAt = header.search(/Total Charges/);
  if (totalAt >= 0) sa.totalCents = amountsIn(header.slice(totalAt))[0] ?? null;

  const region = block.slice(headerEnd).replace(/[ \t]+/g, " ");
  const labels: string[] = [];
  const remainder = region.replace(LABEL, (label) => {
    labels.push(label.trim());
    return "\n";
  });
  const amounts = amountsIn(remainder);
  if (labels.length !== amounts.length) {
    sa.problem = `${labels.length} charge labels but ${amounts.length} amounts`;
  }
  const count = Math.min(labels.length, amounts.length);
  for (let index = 0; index < count; index += 1) {
    const label = labels[index] ?? "";
    sa.items.push({ label, amount_usd: fromCents(amounts[index] ?? 0), category: categoryFor(label) });
  }
  if (!sa.problem) {
    const sum = amounts.reduce((total, cents) => total + cents, 0);
    if (sa.totalCents == null) sa.problem = "Total Charges not found";
    else if (sum !== sa.totalCents) sa.problem = `lines ${fromCents(sum)} != Total Charges ${fromCents(sa.totalCents)}`;
  }
  return sa;
}

function billIdBefore(ids: readonly { index: number; id: string }[], index: number): string {
  let found = "";
  for (const entry of ids) {
    if (entry.index > index) break;
    found = entry.id;
  }
  return found;
}

function billIdAfter(ids: readonly { index: number; id: string }[], index: number): string {
  return ids.find((entry) => entry.index > index)?.id ?? "";
}

/**
 * Account Summary. -layout prints "Current Charges  $X" on one line. unpdf
 * prints the labels, then Previous Balance, Payments, Current Charges and
 * Account Balance amounts; Current Charges is the one before Account Balance.
 */
function currentCharges(summary: string): number | null {
  const inline = /Current Charges[ \t]+(-?)\$(-?)([\d,]+\.\d{2})/.exec(summary);
  if (inline) return toCents(inline[1] ?? "", inline[2] ?? "", inline[3] ?? "");
  const afterLabels = summary.split(/Account Balance/)[1] ?? "";
  const amounts = amountsIn(afterLabels);
  return amounts.length >= 2 ? (amounts.at(-2) ?? null) : null;
}

/** Meter Consumption Details: meter number and Meter Total demand per SA. */
function meterTables(text: string, ids: readonly { index: number; id: string }[]): Map<string, MeterInfo> {
  const meters = new Map<string, MeterInfo>();
  for (const table of text.matchAll(/Meter Consumption Details/g)) {
    if (table.index === undefined) continue;
    const billId = billIdBefore(ids, table.index);
    const rest = text.slice(table.index + table[0].length);
    const stop = rest.search(/\[Record\*|Account Summary|Lobby and Telephone Hours|PLEASE DETACH/);
    const section = stop >= 0 ? rest.slice(0, stop) : rest;
    const lines = section.split("\n");
    for (const [at, line] of lines.entries()) {
      const sa = /SA ID:[ \t]*(\d+)/.exec(line);
      if (!sa) continue;
      const meterLine = lines[at + 1] ?? "";
      const meter = /^\s*(\d{4,})\s/.exec(meterLine)?.[1] ?? "";
      let demandKw = "";
      for (let next = at + 1; next < lines.length; next += 1) {
        const candidate = lines[next] ?? "";
        if (/SA ID:/.test(candidate)) break;
        if (!/Meter Total/.test(candidate)) continue;
        const numbers = candidate
          .replace(/\d{2}\/\d{2}\/\d{2}/g, " ")
          .match(/\d[\d,]*\.\d+/g);
        demandKw = numbers?.[1] ?? "";
        break;
      }
      const key = `${billId}|${sa[1] ?? ""}`;
      if (!meters.has(key)) meters.set(key, { meter, demandKw });
    }
  }
  return meters;
}

/** SA IDs in the meter table may run straight into the street number in unpdf text. */
function meterFor(meters: Map<string, MeterInfo>, billId: string, saId: string): MeterInfo | undefined {
  const exact = meters.get(`${billId}|${saId}`);
  if (exact) return exact;
  for (const [key, info] of meters) {
    const [id, sa] = key.split("|");
    if (id === billId && sa?.startsWith(saId)) return info;
  }
  return undefined;
}

function nearestDate(text: string, pattern: RegExp, index: number): string {
  let best = "";
  let distance = Number.POSITIVE_INFINITY;
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue;
    const gap = Math.abs(match.index - index);
    if (gap < distance) {
      distance = gap;
      best = isoDate(match[1] ?? "");
    }
  }
  return distance <= 600 ? best : "";
}

function statements(text: string): Statement[] {
  const ids = [...text.matchAll(/Bill ID:[ \t]*(\d+)/g)].map((match) => ({ index: match.index ?? 0, id: match[1] ?? "" }));
  const byId = new Map<string, Statement>();
  const order: Statement[] = [];
  const statementFor = (billId: string): Statement => {
    let statement = byId.get(billId);
    if (!statement) {
      statement = { billId, blocks: [], currentCents: null, billDate: "", dueDate: "" };
      byId.set(billId, statement);
      order.push(statement);
    }
    return statement;
  };

  for (const entry of ids) {
    const statement = statementFor(entry.id);
    if (!statement.billDate) {
      statement.billDate =
        nearestDate(text, /Bill Date:[ \t]*(\d{2}\/\d{2}\/\d{2,4})/g, entry.index) ||
        nearestDate(text, /(\d{2}\/\d{2}\/\d{2,4})\s*\n\s*Date Due:/g, entry.index);
    }
    if (!statement.dueDate) statement.dueDate = nearestDate(text, /Date Due:[ \t]*(\d{2}\/\d{2}\/\d{2,4})/g, entry.index);
  }

  for (const summary of text.matchAll(/Account Summary/g)) {
    if (summary.index === undefined) continue;
    const billId = billIdAfter(ids, summary.index);
    if (!billId) continue;
    const rest = text.slice(summary.index);
    const stop = rest.search(/Account Activity|Current Charges Detail/);
    const statement = statementFor(billId);
    if (statement.currentCents == null) statement.currentCents = currentCharges(stop >= 0 ? rest.slice(0, stop) : rest);
  }

  const headers = [...text.matchAll(SA_HEADER)];
  const seen = new Set<string>();
  for (const [position, header] of headers.entries()) {
    if (header.index === undefined) continue;
    const from = lineStart(text, header.index);
    const next = headers[position + 1]?.index;
    const to = next === undefined ? text.length : lineStart(text, next);
    const billId = billIdBefore(ids, header.index);
    const saId = header[1] ?? "";
    const key = `${billId}|${saId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    statementFor(billId).blocks.push(parseBlock(blockText(text, from, to), saId, billId));
  }
  return order.filter((statement) => statement.blocks.length > 0);
}

function isLighting(block: SaBlock, meter: MeterInfo | undefined): boolean {
  if (/^SL/i.test(block.rateCode)) return true;
  if (meter) return false;
  return !block.items.some((item) => /^(?:Summer|Winter)\b.*\bkWh\b/i.test(item.label));
}

function seasonKwh(items: readonly ChargeLine[]): string {
  let total = 0;
  let found = false;
  for (const item of items) {
    const match = /^(?:Summer|Winter|Energy)\b[^@]*?([\d,]+(?:\.\d+)?)\s*kWh\b/i.exec(item.label);
    if (!match) continue;
    total += Number((match[1] ?? "").replaceAll(",", ""));
    found = true;
  }
  return found ? String(Math.round(total * 1000) / 1000) : "";
}

function sumCategory(items: readonly ChargeLine[], category: ChargeCategory): number {
  return items
    .filter((item) => item.category === category && item.service !== "non_electric")
    .reduce((total, item) => total + Math.round(Number(item.amount_usd) * 100), 0);
}

function customerBlock(text: string): { name: string; city: string; state: string; zip: string } {
  const match = /\n[ \t]*([A-Z][A-Z0-9 &.,'-]+?)[ \t]*\n[ \t]*\d+[ \t]+[A-Z0-9 .#'-]+?[ \t]*\n[ \t]*([A-Z][A-Z .]+?),?[ \t]+([A-Z]{2})[ \t]+(\d{5})(?:-\d{4})?/.exec(text);
  return {
    name: (match?.[1] ?? "").trim(),
    city: (match?.[2] ?? "").trim(),
    state: match?.[3] ?? "",
    zip: match?.[4] ?? "",
  };
}

function accountNumber(text: string): string {
  return (
    /Account Number:[ \t]*(\d{6,})/.exec(text)?.[1] ??
    /Page \d+ of \d+\s*\n\s*(\d{6,})\s*\n/.exec(text)?.[1] ??
    /KEY=(\d{6,})\*/.exec(text)?.[1] ??
    ""
  );
}

function titleCase(value: string): string {
  return value.toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

export function parseMidBills(text: string, sourceFile: string): BillDraft[] {
  const source = normalizeText(text);
  const ids = [...source.matchAll(/Bill ID:[ \t]*(\d+)/g)].map((match) => ({ index: match.index ?? 0, id: match[1] ?? "" }));
  const meters = meterTables(source, ids);
  const customer = customerBlock(source);
  const account = accountNumber(source);
  const rows: BillDraft[] = [];

  for (const statement of statements(source)) {
    const metered: { block: SaBlock; meter: MeterInfo | undefined }[] = [];
    const lighting: SaBlock[] = [];
    for (const block of statement.blocks) {
      const meter = meterFor(meters, statement.billId, block.saId);
      if (isLighting(block, meter)) lighting.push(block);
      else metered.push({ block, meter });
    }
    if (metered.length === 0) continue;

    const saTotal = statement.blocks.reduce((total, block) => total + (block.totalCents ?? 0), 0);
    let statementProblem = "";
    if (statement.currentCents == null) statementProblem = "Current Charges not found";
    else if (saTotal !== statement.currentCents) {
      statementProblem = `SA totals ${fromCents(saTotal)} != Current Charges ${fromCents(statement.currentCents)}`;
    }

    for (const [position, { block, meter }] of metered.entries()) {
      const row = emptyBill(sourceFile);
      row.utility = "Modesto Irrigation District";
      row.parser_id = MID_PARSER_ID;
      row.customer_name = customer.name;
      row.customer_account = account;
      row.service_account = block.saId;
      row.meter_id = meter?.meter || block.saId;
      row.service_address = block.address;
      row.service_city = block.city || titleCase(customer.city);
      row.service_state = customer.state;
      row.service_zip = block.city && titleCase(block.city) === titleCase(customer.city) ? customer.zip : "";
      row.rate_schedule = block.rateCode;
      row.billing_period_start = block.start;
      row.billing_period_end = block.end;
      row.billing_days = daysBetween(block.start, block.end);
      row.kwh_total = seasonKwh(block.items);
      row.demand_kw_max = meter?.demandKw ?? "";
      row.bill_prepared_date = statement.billDate;
      row.due_date = statement.dueDate;

      const items: ChargeLine[] = [...block.items];
      const carried = position === 0 ? lighting : [];
      for (const light of carried) {
        items.push({
          label: `${light.rateCode} ${light.rateName} ${light.address} SA ${light.saId} Total Charges`.replace(/\s+/g, " ").trim(),
          amount_usd: fromCents(light.totalCents ?? 0),
          category: "other",
          service: "non_electric",
          service_type: "other",
        });
      }
      row.line_items_json = JSON.stringify(items);

      const energy = sumCategory(items, "energy");
      const demand = sumCategory(items, "demand");
      const taxes = sumCategory(items, "tax");
      const fees = sumCategory(items, "fee");
      const electric = block.totalCents ?? 0;
      const nonElectric = carried.reduce((total, light) => total + (light.totalCents ?? 0), 0);
      row.energy_charges_usd = fromCents(energy);
      row.demand_charges_usd = fromCents(demand);
      row.taxes_usd = fromCents(taxes);
      row.fees_usd = fromCents(fees);
      if (block.totalCents != null) {
        row.electric_total_usd = fromCents(electric);
        row.other_charges_usd = fromCents(electric - energy - demand - taxes - fees);
        if (carried.length > 0) row.non_electric_charges_usd = fromCents(nonElectric);
        row.total_new_charges_usd = fromCents(electric + nonElectric);
        row.amount_due_usd = row.total_new_charges_usd;
      }

      const problems = [
        block.problem && `SA ${block.saId}: ${block.problem}`,
        ...carried.filter((light) => light.problem).map((light) => `SA ${light.saId}: ${light.problem}`),
        statementProblem,
      ].filter(Boolean);
      const summary = `statement current charges ${statement.currentCents == null ? "?" : fromCents(statement.currentCents)}`;
      row.notes = problems.length > 0 ? `needs_review: ${problems.join("; ")}` : summary;
      row.parse_confidence = problems.length > 0 ? "0.50" : "1.00";
      rows.push(row);
    }
  }
  return rows;
}

export const midParser: BillParser = {
  id: MID_PARSER_ID,
  match(text: string): boolean {
    const source = normalizeText(text);
    const mid = /Modesto Irrigation District/i.test(source) || /customerservice@mid\.org/i.test(source);
    return mid && /SA ID:/.test(source) && /Bill Period:/.test(source);
  },
  parse: parseMidBills,
};
