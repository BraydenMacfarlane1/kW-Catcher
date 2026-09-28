import { emptyBill, type BillDraft, type BillParser } from "./base";
import type { ChargeCategory, ChargeLine, LineService, LineServiceType } from "./charges";

export const LOGAN_CITY_PARSER_ID = "logan-city-lp";

const NOISE_NAME = /\b(FIRE|DANGER|CAUTION|PLEASE|RETURN|BILLING|EXTREME|TERMS|FINANCE)\b/;

interface ChargeSpec {
  pattern: RegExp;
  label: string;
  service: LineService;
  serviceType?: LineServiceType;
  category: ChargeCategory;
  taxInclusive: boolean;
  embeddedTaxRate: string | null;
  skip?: boolean;
}

interface FoundCharge extends ChargeSpec {
  index: number;
  options: number[];
}

const CHARGE_SPECS: readonly ChargeSpec[] = [
  { pattern: /Balance at Billing/i, label: "Balance at Billing", service: "electric", category: "other", taxInclusive: false, embeddedTaxRate: null, skip: true },
  { pattern: /911\s+Dispatch/i, label: "911 Dispatch", service: "non_electric", serviceType: "dispatch", category: "other", taxInclusive: false, embeddedTaxRate: null },
  { pattern: /Electric\s+Commercial\s+Flat\s+3\s+Phase/i, label: "Electric Commercial Flat 3 Phase", service: "electric", category: "fee", taxInclusive: true, embeddedTaxRate: "0.06" },
  { pattern: /Electric\s+Commercial\s+Usage/i, label: "Electric Commercial Usage", service: "electric", category: "energy_demand", taxInclusive: true, embeddedTaxRate: "0.06" },
  { pattern: /GB\s+Comm\s+[A-Za-z]+\s+90\s+Gal(?:\s+\d+\s+Pickup\w*)?/i, label: "GB Comm City 90 Gal 1 Pickup/Wk", service: "non_electric", serviceType: "garbage", category: "other", taxInclusive: false, embeddedTaxRate: null },
  { pattern: /Recycle\s+90\s+Gal(?:\s+Logan\s+Pkup\s+\w+)?/i, label: "Recycle 90 Gal Logan Pkup Biwkly", service: "non_electric", serviceType: "recycle", category: "other", taxInclusive: false, embeddedTaxRate: null },
  { pattern: /Sewer\s+Collection\s+Commercial\s+Flat/i, label: "Sewer Collection Commercial Flat", service: "non_electric", serviceType: "sewer", category: "other", taxInclusive: false, embeddedTaxRate: null },
  { pattern: /Sewer\s+Commercial\s+Usage/i, label: "Sewer Commercial Usage", service: "non_electric", serviceType: "sewer", category: "other", taxInclusive: false, embeddedTaxRate: null },
  { pattern: /Sewer\s+Treatment\s+Commercial\s+Flat/i, label: "Sewer Treatment Commercial Flat", service: "non_electric", serviceType: "sewer", category: "other", taxInclusive: false, embeddedTaxRate: null },
  { pattern: /Storm\s+Water\s+Commercial/i, label: "Storm Water Commercial", service: "non_electric", serviceType: "storm", category: "other", taxInclusive: false, embeddedTaxRate: null },
  { pattern: /Water\s+Commercial\s+Flat/i, label: 'Water Commercial Flat <1"', service: "non_electric", serviceType: "water", category: "other", taxInclusive: false, embeddedTaxRate: null },
  { pattern: /Water\s+Commercial\s+Usage/i, label: "Water Commercial Usage", service: "non_electric", serviceType: "water", category: "other", taxInclusive: false, embeddedTaxRate: null },
];

function toCents(value: string): number {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100);
}

function fromCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function mdY(value: string): string {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!match) return "";
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function billingDays(start: string, end: string): string {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return "";
  const days = Math.round((to - from) / 86_400_000);
  return days > 0 && days < 400 ? String(days) : "";
}

function mostCommon(counts: Map<string, number>): string {
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  return ranked[0]?.[0] ?? "";
}

function customerName(text: string): string {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(/\b((?:[A-Z]{2,}\s+){2,}[A-Z]{2,})\b/g)) {
    const name = (match[1] ?? "").replace(/\s+/g, " ").trim();
    if (!name || NOISE_NAME.test(name)) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return mostCommon(counts);
}

function serviceAddress(text: string): string {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(/\b(\d{1,6}\s+[NSEW]\s+[A-Z]+(?:\s+[A-Z]+){0,4})\b/g)) {
    const value = (match[1] ?? "").replace(/\s+/g, " ").trim();
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return mostCommon(counts);
}

function mailingPlace(text: string): { city: string; state: string; zip: string } {
  const match = /\b([A-Z]{3,})\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\b/.exec(text);
  return { city: match?.[1] ?? "", state: match?.[2] ?? "", zip: match?.[3] ?? "" };
}

function accountNumber(text: string): string {
  return /\b(\d{6}-\d{3})\b/.exec(text)?.[1] ?? "";
}

/** Payment stub: account digits, then amount due in cents (`0000150204` = 1502.04). */
function scanlineDueCents(text: string, account: string): number | null {
  const compact = account.replaceAll("-", "");
  if (!/^\d{9}$/.test(compact)) return null;
  const match = new RegExp(String.raw`\b${compact}\s+(\d{6,12})\b`).exec(text);
  if (!match?.[1]) return null;
  const cents = Number(match[1]);
  return Number.isFinite(cents) ? cents : null;
}

function servicePeriod(text: string): { start: string; end: string } {
  const match = /(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})/.exec(text);
  return { start: mdY(match?.[1] ?? ""), end: mdY(match?.[2] ?? "") };
}

function billDates(text: string, periodEnd: string): { prepared: string; due: string } {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b(\d{1,2}\/\d{1,2}\/\d{4})\b/g)) {
    const iso = mdY(match[1] ?? "");
    if (iso) found.add(iso);
  }
  const later = [...found].filter((iso) => periodEnd && iso > periodEnd).sort();
  if (later.length >= 2) return { prepared: later[0] ?? "", due: later[later.length - 1] ?? "" };
  if (later.length === 1) return { prepared: "", due: later[0] ?? "" };
  return { prepared: "", due: "" };
}

function plainNumber(value: string): string {
  return value.replaceAll(",", "").trim();
}

/** Multiplier, then the charge. Skips a size token such as `<1"` and OCR junk before the numbers. */
function readAmount(rest: string): string | null {
  let window = rest.slice(0, 160).replace(/^[^\d]*/, "");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const match = /^((?:\d{1,3}(?:,\d{3})*|\d+)(?:[.,]\d{2})|000)\s+([\d,]+(?:\.\d{2})?)\b/.exec(window);
    if (match?.[2]) return match[2];
    const next = window.replace(/^\S+\s*/, "").replace(/^[^\d]*/, "");
    if (!next || next === window) break;
    window = next;
  }
  return null;
}

/**
 * A token with no decimal point can be whole dollars or the same digits with the point dropped.
 * `3021` is either 3021.00 or 30.21. The bill-total checksum picks one.
 */
function amountOptions(token: string): number[] {
  const cleaned = token.replaceAll(",", "").trim();
  if (/^\d+\.\d{2}$/.test(cleaned)) return [toCents(cleaned)];
  if (/^\d+$/.test(cleaned) && cleaned.length > 2) {
    const digits = Number(cleaned);
    return [digits * 100, digits];
  }
  if (/^\d+$/.test(cleaned)) return [Number(cleaned) * 100];
  return [];
}

function findCharges(text: string): FoundCharge[] {
  const found: FoundCharge[] = [];
  for (const spec of CHARGE_SPECS) {
    const match = spec.pattern.exec(text);
    if (!match || match.index === undefined || spec.skip) continue;
    const token = readAmount(text.slice(match.index + match[0].length));
    if (!token) continue;
    const options = amountOptions(token);
    if (options.length === 0) continue;
    found.push({ ...spec, index: match.index, options });
  }
  return found.sort((a, b) => a.index - b.index);
}

interface AmountChoice {
  amounts: number[];
  exact: boolean;
}

function chooseAmounts(optionSets: readonly (readonly number[])[], target: number | null): AmountChoice {
  const literal = optionSets.map((options) => options[0] ?? 0);
  if (target == null || optionSets.length === 0) return { amounts: literal, exact: false };

  const state: { best: { amounts: number[]; distance: number; repairs: number } | null; exactTies: number } = {
    best: null,
    exactTies: 0,
  };
  const chosen: number[] = [];

  const walk = (index: number, sum: number, repairs: number): void => {
    if (index === optionSets.length) {
      const distance = Math.abs(sum - target);
      const best = state.best;
      if (!best || distance < best.distance || (distance === best.distance && repairs < best.repairs)) {
        state.best = { amounts: chosen.slice(), distance, repairs };
        state.exactTies = distance === 0 ? 1 : 0;
      } else if (distance === 0 && best.distance === 0 && repairs === best.repairs) {
        state.exactTies += 1;
      }
      return;
    }
    const options = optionSets[index] ?? [0];
    for (let choice = 0; choice < options.length; choice += 1) {
      chosen.push(options[choice] ?? 0);
      walk(index + 1, sum + (options[choice] ?? 0), repairs + (choice === 0 ? 0 : 1));
      chosen.pop();
    }
  };

  walk(0, 0, 0);
  if (!state.best || state.exactTies > 1) return { amounts: literal, exact: false };
  return { amounts: state.best.amounts, exact: state.best.distance === 0 };
}

function sumWhere(charges: readonly FoundCharge[], amounts: readonly number[], include: (charge: FoundCharge) => boolean): number {
  return charges.reduce((total, charge, index) => total + (include(charge) ? (amounts[index] ?? 0) : 0), 0);
}

function lineItem(charge: FoundCharge, cents: number): ChargeLine {
  const line: ChargeLine = {
    label: charge.label,
    amount_usd: fromCents(cents),
    category: charge.category,
    service: charge.service,
  };
  if (charge.service === "non_electric" && charge.serviceType) line.service_type = charge.serviceType;
  line.tax_inclusive = charge.taxInclusive;
  line.embedded_tax_rate = charge.embeddedTaxRate;
  return line;
}

function reviewNotes(due: number | null, lines: number, electric: number, nonElectric: number): string {
  if (due == null) return "needs_review: bill total checksum failed: amount due missing";
  if (lines === due && electric + nonElectric === due) return "";
  const parts = [
    `bill total checksum failed: lines ${fromCents(lines)} != ${fromCents(due)}`,
    `electric total checksum failed: electric lines ${fromCents(electric)} != ${fromCents(due - nonElectric)}`,
  ];
  return `needs_review: ${parts.join("; ")}`;
}

export function parseLoganCityBills(text: string, sourceFile: string): BillDraft[] {
  const row = emptyBill(sourceFile);
  row.utility = "Logan City Light & Power";
  row.parser_id = LOGAN_CITY_PARSER_ID;
  row.customer_name = customerName(text);
  row.customer_account = accountNumber(text);
  row.service_address = serviceAddress(text);
  const place = mailingPlace(text);
  row.service_city = place.city;
  row.service_state = place.state;
  row.service_zip = place.zip;

  const period = servicePeriod(text);
  row.billing_period_start = period.start;
  row.billing_period_end = period.end;
  row.billing_days = billingDays(period.start, period.end);
  const dates = billDates(text, period.end);
  row.bill_prepared_date = dates.prepared;
  row.due_date = dates.due;

  const kwh = /Electric\s+(\d{4,10})\s+[\d,.]+\s*kWh\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)/i.exec(text);
  if (kwh) {
    row.meter_id = kwh[1] ?? "";
    row.kwh_total = plainNumber(kwh[4] ?? "");
  }
  const demand = /Electric\s+\d{4,10}\s+[\d,.]+\s*kW\s+\d+\s+\d+\s+(\d+)/i.exec(text);
  if (demand?.[1]) row.demand_kw_max = demand[1];

  const charges = findCharges(text);
  const due = scanlineDueCents(text, row.customer_account);
  const choice = chooseAmounts(
    charges.map((charge) => charge.options),
    due,
  );
  const items = charges.map((charge, index) => lineItem(charge, choice.amounts[index] ?? 0));
  row.line_items_json = JSON.stringify(items);

  const electric = sumWhere(charges, choice.amounts, (charge) => charge.service === "electric");
  const nonElectric = sumWhere(charges, choice.amounts, (charge) => charge.service === "non_electric");
  const energyCents = sumWhere(charges, choice.amounts, (charge) => charge.category === "energy");
  const demandCents = sumWhere(charges, choice.amounts, (charge) => charge.category === "demand");
  const fees = sumWhere(charges, choice.amounts, (charge) => charge.category === "fee");
  const combined = sumWhere(charges, choice.amounts, (charge) => charge.category === "energy_demand");
  const lines = electric + nonElectric;

  if (charges.some((charge) => charge.service === "electric")) {
    row.electric_total_usd = fromCents(electric);
    row.non_electric_charges_usd = fromCents(nonElectric);
    row.fees_usd = fromCents(fees);
    row.taxes_usd = "0.00";
    const energyOut = combined > 0 ? 0 : energyCents;
    const demandOut = combined > 0 ? 0 : demandCents;
    if (combined > 0) row.energy_demand_combined_usd = fromCents(combined);
    if (energyOut > 0) row.energy_charges_usd = fromCents(energyOut);
    if (demandOut > 0) row.demand_charges_usd = fromCents(demandOut);
    const residual = electric - energyOut - demandOut - combined - fees;
    row.other_charges_usd = fromCents(residual);
    row.charges_tax_inclusive = "true";
    row.embedded_tax_rate = "0.06";
  }

  if (due != null) {
    row.total_new_charges_usd = fromCents(due);
    row.amount_due_usd = fromCents(due);
  }

  const notes = reviewNotes(due, lines, electric, nonElectric);
  row.notes = notes;
  row.parse_confidence = notes ? "0.50" : "1.00";
  return [row];
}

export const loganCityParser: BillParser = {
  id: LOGAN_CITY_PARSER_ID,
  match(text: string): boolean {
    const utility = /435-716-9208/.test(text) || /loganutah/i.test(text) || /Logan,\s*Utah\s*84323/i.test(text);
    const bill = /Monthly Utility Bill/i.test(text) || /Electric Commercial/i.test(text);
    const named = /Logan City Light\s*(?:&|and)\s*Power/i.test(text);
    return (utility && bill) || named;
  },
  parse: parseLoganCityBills,
};
