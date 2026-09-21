import type { BillDraft } from "./base";

export type ChargeCategory = "tax" | "fee" | "energy" | "demand" | "other";

export interface ChargeLine {
  label: string;
  amount_usd: string;
  category: ChargeCategory;
}

/** Charge lines from "Details of your new charges". Empty when that section is absent. */
export function extractChargeLines(text: string): ChargeLine[] {
  const section = detailsSection(text);
  if (!section) return [];
  const lines: ChargeLine[] = [];
  for (const raw of section.split("\n")) {
    const line = raw.trim();
    if (!line || skipLine(line)) continue;
    const amount = lastAmount(line);
    if (!amount) continue;
    const label = chargeLabel(line.slice(0, amount.index));
    if (!label) continue;
    lines.push({
      label,
      amount_usd: fromCents(amount.cents),
      category: categorize(label, line),
    });
  }
  return lines;
}

/** When detail lines exist, taxes and fees are their sums and other_charges is the residual. */
export function applyChargeSplit(row: BillDraft, text: string): void {
  const items = extractChargeLines(text);
  row.line_items_json = JSON.stringify(items);
  if (items.length === 0) return;

  const taxes = sumCategory(items, "tax");
  const fees = sumCategory(items, "fee");
  row.taxes_usd = fromCents(taxes);
  row.fees_usd = fromCents(fees);

  if (row.total_new_charges_usd && Number.isFinite(Number(row.total_new_charges_usd))) {
    const residual =
      toCents(row.total_new_charges_usd) -
      toCents(row.energy_charges_usd) -
      toCents(row.demand_charges_usd) -
      taxes -
      fees;
    row.other_charges_usd = fromCents(residual);
  }
}

function detailsSection(text: string): string | null {
  const start = /(?:^|\n)\s*Details of your new charges\s*(?:\n|$)/.exec(text);
  if (!start || start.index === undefined) return null;
  const rest = text.slice(start.index + start[0].length);
  const end = /(?:^|\n)\s*(?:Things you should know|Rate Identification Number)\b/.exec(rest);
  return end && end.index !== undefined ? rest.slice(0, end.index) : rest;
}

function skipLine(line: string): boolean {
  if (/[·•]/.test(line)) return true;
  if (/charges include/i.test(line)) return true;
  if (/^additional information\b/i.test(line)) return true;
  if (/^details of your new charges\b/i.test(line)) return true;
  if (/^your rate:/i.test(line)) return true;
  if (/^billing period:/i.test(line)) return true;
  if (/^(delivery|generation|other) charges\b/i.test(line)) return true;
  if (/^energy-/i.test(line)) return true;
  if (/^demand-/i.test(line)) return true;
  if (/^sce$/i.test(line)) return true;
  if (/^subtotal\b/i.test(line)) return true;
  if (/^your new charges\b/i.test(line)) return true;
  return false;
}

function lastAmount(line: string): { cents: number; index: number; length: number } | null {
  let found: { cents: number; index: number; length: number } | null = null;
  for (const match of line.matchAll(/(-)?\$([\d,]+\.\d{2})(?!\d)/g)) {
    if (match.index === undefined) continue;
    const negative = match[1] === "-";
    const cents = toCents((match[2] ?? "").replaceAll(",", ""));
    found = { cents: negative ? -cents : cents, index: match.index, length: match[0].length };
  }
  return found;
}

function chargeLabel(beforeAmount: string): string {
  return beforeAmount
    .replace(/\s+/g, " ")
    .replace(/\s+[\d,]+\s*kWh\s+x\s+\$[\d.]+\s*$/i, "")
    .replace(/\s+[\d,]+\s*kW\s+x\s+\$[\d.]+\s*$/i, "")
    .replace(/\s+\$[\d,]+\.\d+\s+x\s+[\d.]+%\s*$/i, "")
    .trim();
}

function categorize(label: string, line: string): ChargeCategory {
  if (/\buut\b|\btax\b/i.test(label)) return "tax";
  if (
    /customer charge|franchise|wildfire|public purpose|fixed recovery|nuclear decommission|competition transition|new system generation/i.test(
      label,
    )
  ) {
    return "fee";
  }
  const demandLine = /\bkW\b/i.test(line) && !/\bkWh\b/i.test(line);
  if (/\bdemand\b/i.test(label) || demandLine) return "demand";
  if (/\bkWh\b/i.test(line) || /\benergy\b/i.test(label)) return "energy";
  return "other";
}

function sumCategory(items: readonly ChargeLine[], category: ChargeCategory): number {
  return items.filter((item) => item.category === category).reduce((total, item) => total + toCents(item.amount_usd), 0);
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
