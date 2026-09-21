import { emptyBill, type BillDraft, type BillParser } from "./base";

export const SCE_PARSER_ID = "sce_tou_gs2_layout_v1";

function money(value: string | undefined): string {
  if (!value) return "";
  return value.replaceAll(",", "").replaceAll("$", "").trim();
}

function num(value: string | undefined): string {
  if (!value) return "";
  return value.replaceAll(",", "").trim();
}

function toIso(mmddyy: string): string {
  const [m, d, y] = mmddyy.split("/");
  let year = Number(y);
  if (year < 100) year += 2000;
  return `${String(year).padStart(4, "0")}-${String(Number(m)).padStart(2, "0")}-${String(Number(d)).padStart(2, "0")}`;
}

function first(pattern: RegExp, text: string): string | undefined {
  const match = pattern.exec(text);
  if (!match) return undefined;
  return (match[1] ?? match[0]).trim();
}

function normalizeText(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\f", "\n");
}

function peakKwh(block: string, kind: "on" | "mid" | "off" | "super"): string {
  let source = block;
  if (kind === "off") {
    source = source.replace(/super\s+off\s+peak\s+[\d,]+\s*kWh/gi, "");
  }
  const pattern = {
    on: /(?<!\w)on\s+peak\s+([\d,]+)\s*kWh/i,
    mid: /mid\s+peak\s+([\d,]+)\s*kWh/i,
    off: /(?<!\w)off\s+peak\s+([\d,]+)\s*kWh/i,
    super: /super\s+off\s+peak\s+([\d,]+)\s*kWh/i,
  }[kind];
  const match = pattern.exec(source);
  return match ? num(match[1]) : "";
}

function extractUsageBlock(text: string): {
  kwh_on_peak: string;
  kwh_mid_peak: string;
  kwh_off_peak: string;
  kwh_super_off_peak: string;
  kwh_total_from_usage: string;
  energy_charges_usd: string;
  demand_charges_usd: string;
  other_charges_usd: string;
  total_new_charges_usd: string;
} {
  const out = {
    kwh_on_peak: "",
    kwh_mid_peak: "",
    kwh_off_peak: "",
    kwh_super_off_peak: "",
    kwh_total_from_usage: "",
    energy_charges_usd: "",
    demand_charges_usd: "",
    other_charges_usd: "",
    total_new_charges_usd: "",
  };
  let match = /Usage\s+Avg\. cost\s+Total cost\n(.*?)(?:Summer|Winter|Summer and Winter) season demand/s.exec(text);
  if (!match) {
    match = /Usage\s+Avg\. cost\s+Total cost\n(.*?)Your past and current/s.exec(text);
  }
  if (!match) return out;
  const block = match[1] ?? "";

  out.kwh_on_peak = peakKwh(block, "on");
  out.kwh_mid_peak = peakKwh(block, "mid");
  out.kwh_off_peak = peakKwh(block, "off");
  out.kwh_super_off_peak = peakKwh(block, "super");

  const total = /([\d,]+)\s*kWh\s+\$([\d,]+\.\d{2})\s+Energy Charges/.exec(block);
  if (total) {
    out.kwh_total_from_usage = num(total[1]);
    out.energy_charges_usd = money(total[2]);
  } else {
    const energy = first(/\$([\d,]+\.\d{2})\s+Energy Charges/, block);
    if (energy) out.energy_charges_usd = money(energy);
  }

  const demand = first(/\$([\d,]+\.\d{2})\s+Demand Charges/, block);
  if (demand) out.demand_charges_usd = money(demand);
  const other = first(/\$([\d,]+\.\d{2})\s+Other credits\/charges/, block);
  if (other) out.other_charges_usd = money(other);
  const charges = first(/\$([\d,]+\.\d{2})\s+Total\b/, block);
  if (charges) out.total_new_charges_usd = money(charges);
  return out;
}

function formatKw(values: number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values);
  return max === Math.trunc(max) ? String(Math.trunc(max)) : String(max);
}

function kwValues(block: string, pattern: RegExp): number[] {
  return [...block.matchAll(pattern)].map((match) => Number(num(match[1])));
}

function extractDemand(text: string): Pick<
  BillDraft,
  | "demand_kw_max"
  | "demand_kw_on_peak"
  | "demand_kw_mid_peak"
  | "demand_kw_off_peak"
  | "demand_kw_super_off_peak"
> {
  const out = {
    demand_kw_max: "",
    demand_kw_on_peak: "",
    demand_kw_mid_peak: "",
    demand_kw_off_peak: "",
    demand_kw_super_off_peak: "",
  };
  const max = first(
    /Your maximum demand reached this billing period is\s+([\d,]+(?:\.\d+)?)\s*kW/i,
    text,
  );
  if (max) out.demand_kw_max = num(max);

  const broad = /(Maximum (?:Summer and Winter|Summer|Winter) demand reached by price period\s*:.*?)(?:To view your demand charges|Your past and current)/is.exec(
    text,
  );
  const narrow = /Maximum (?:Summer|Winter|Summer and Winter)?\s*demand reached by price period\s*:(.*?)(?:To view your demand charges|Your past and current)/is.exec(
    text,
  );
  const block = broad?.[1] ?? narrow?.[1] ?? "";

  out.demand_kw_on_peak = formatKw(
    kwValues(block, /(?<!super\s)(?<!\w)on\s+peak\s+([\d,]+(?:\.\d+)?)\s*kW/gi),
  );
  out.demand_kw_mid_peak = formatKw(kwValues(block, /mid\s+peak\s+([\d,]+(?:\.\d+)?)\s*kW/gi));
  out.demand_kw_super_off_peak = formatKw(
    kwValues(block, /super\s+off\s+peak\s+([\d,]+(?:\.\d+)?)\s*kW/gi),
  );
  const withoutSuper = block.replace(/super\s+off\s+peak\s+[\d,]+(?:\.\d+)?\s*kW/gi, "");
  out.demand_kw_off_peak = formatKw(
    kwValues(withoutSuper, /(?<!\w)off\s+peak\s+([\d,]+(?:\.\d+)?)\s*kW/gi),
  );
  return out;
}

function parseService(text: string): Pick<
  BillDraft,
  "service_account" | "pod_id" | "service_address" | "service_city" | "service_state" | "service_zip"
> {
  const empty = {
    service_account: "",
    pod_id: "",
    service_address: "",
    service_city: "",
    service_state: "",
    service_zip: "",
  };
  const layout =
    /Service account\s+POD-ID\s*\n\s*(\d+)\s+(\d+)\s*\n\s*([^\n]+)\n\s*([A-Z .'-]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/.exec(
      text,
    );
  if (layout) {
    return {
      service_account: layout[1] ?? "",
      pod_id: layout[2] ?? "",
      service_address: (layout[3] ?? "").trim(),
      service_city: (layout[4] ?? "").trim(),
      service_state: (layout[5] ?? "").trim(),
      service_zip: (layout[6] ?? "").trim(),
    };
  }

  const stacked =
    /Service account\s*\n\s*(\d+)\s*\n\s*([^\n]+)\n\s*([A-Z .'-]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/.exec(
      text,
    );
  const pod = first(/POD-ID\s*\n\s*(\d{10,})/, text) ?? first(/POD-ID\s+(\d{10,})/, text);
  if (!stacked && !pod) return empty;
  return {
    service_account: stacked?.[1] ?? first(/Service account\s+(\d{6,})/, text) ?? "",
    pod_id: pod ?? "",
    service_address: (stacked?.[2] ?? "").trim(),
    service_city: (stacked?.[3] ?? "").trim(),
    service_state: (stacked?.[4] ?? "").trim(),
    service_zip: (stacked?.[5] ?? "").trim(),
  };
}

export function parseSceBill(text: string, sourceFile: string): BillDraft {
  const source = normalizeText(text);
  const row = emptyBill(sourceFile);
  const notes: string[] = [];
  row.utility = "SCE";
  row.parser_id = SCE_PARSER_ID;

  const name = first(/([A-Z0-9][A-Z0-9 ,.&'/-]+)\s*\/\s*Page\s+\d+/, source);
  if (name) row.customer_name = name.trim();

  const customerAccount =
    first(/Customer account\s*\n\s*(\d{10,})/, source) ??
    first(/Customer account\s+(\d{10,})/, source);
  row.customer_account = customerAccount ?? "";

  const service = parseService(source);
  row.service_account = service.service_account;
  row.pod_id = service.pod_id;
  row.service_address = service.service_address;
  row.service_city = service.service_city;
  row.service_state = service.service_state;
  row.service_zip = service.service_zip;
  if (!row.service_account || !row.pod_id) notes.push("missing service_account/pod_id");

  row.rate_schedule = first(/Your rate:\s*(\S+)/, source) ?? "";

  const rin =
    first(/\b(USCA-[A-Z0-9-]+)\b/, source) ??
    first(/Rate Identification Number\s*-\s*RIN\s+(\S+)/, source);
  row.rin = rin ?? "";

  const period =
    /Billing period:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s+to\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s*\((\d+)\s*days/i.exec(
      source,
    );
  if (period) {
    row.billing_period_start = toIso(period[1] ?? "");
    row.billing_period_end = toIso(period[2] ?? "");
    row.billing_days = period[3] ?? "";
  } else {
    notes.push("missing billing_period");
  }

  const usage = extractUsageBlock(source);
  row.kwh_on_peak = usage.kwh_on_peak;
  row.kwh_mid_peak = usage.kwh_mid_peak;
  row.kwh_off_peak = usage.kwh_off_peak;
  row.kwh_super_off_peak = usage.kwh_super_off_peak;
  row.energy_charges_usd = usage.energy_charges_usd;
  row.demand_charges_usd = usage.demand_charges_usd;
  row.other_charges_usd = usage.other_charges_usd;
  row.total_new_charges_usd = usage.total_new_charges_usd;

  const kwhTotal = first(
    /Total (?:estimated )?electricity (?:usage|you used) this month in kWh\s+([\d,]+)/i,
    source,
  );
  if (kwhTotal) {
    row.kwh_total = num(kwhTotal);
  } else if (usage.kwh_total_from_usage) {
    row.kwh_total = usage.kwh_total_from_usage;
    notes.push("kwh_total from usage sum line");
  } else {
    notes.push("missing kwh_total");
  }

  Object.assign(row, extractDemand(source));

  const amount =
    first(/Amount due\s*\$([\d,]+\.\d{2})/, source) ??
    first(/Your new charges\s+\$([\d,]+\.\d{2})/, source);
  row.amount_due_usd = amount ? money(amount) : "";

  const due = first(/Due by\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/, source);
  if (due) row.due_date = toIso(due);

  const prepared = first(/Date bill prepared\s*\n\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/, source);
  if (prepared) row.bill_prepared_date = toIso(prepared);

  const voltage = first(/Service voltage:\s*([^\n]+)/, source);
  if (voltage) row.service_voltage = voltage.trim().replace(/\.+$/, "");

  const meter = first(/For meter\s+(\S+)/, source);
  if (meter) row.meter_id = meter;

  if (!row.total_new_charges_usd) {
    const newCharges = first(/Your new charges\s+\$([\d,]+\.\d{2})/, source);
    if (newCharges) {
      row.total_new_charges_usd = money(newCharges);
      notes.push("total_new_charges from Your new charges");
    }
  }

  const required = [
    "customer_account",
    "amount_due_usd",
    "kwh_total",
    "billing_period_start",
    "billing_period_end",
  ] as const;
  const missingReq = required.filter((field) => !row[field]);
  const expectedSoft = [
    "service_account",
    "pod_id",
    "rate_schedule",
    "energy_charges_usd",
    "demand_charges_usd",
    "demand_kw_max",
    "meter_id",
    "rin",
  ] as const;
  const missingSoft = expectedSoft.filter((field) => !row[field]);

  const hasOn = Boolean(row.kwh_on_peak);
  const hasSuper = Boolean(row.kwh_super_off_peak);
  if (hasOn && hasSuper) notes.push("transition summer/winter TOU");
  else if (hasSuper && !hasOn) notes.push("winter TOU (no on-peak)");
  else if (hasOn && !hasSuper) notes.push("summer TOU");

  if (missingReq.length > 0) notes.push(`MISSING_REQUIRED:${missingReq.join(",")}`);
  if (missingSoft.length > 0) notes.push(`missing:${missingSoft.join(",")}`);

  let confidence = 1;
  confidence -= 0.25 * missingReq.length;
  confidence -= 0.05 * missingSoft.length;

  try {
    const parts = [
      row.kwh_on_peak,
      row.kwh_mid_peak,
      row.kwh_off_peak,
      row.kwh_super_off_peak,
    ]
      .filter((value) => value)
      .map((value) => Number(value));
    if (parts.length > 0 && row.kwh_total) {
      const sum = parts.reduce((total, value) => total + value, 0);
      const expected = Number(row.kwh_total);
      if (Math.abs(sum - expected) > 1) {
        notes.push(`kwh_peak_sum=${sum} != kwh_total=${expected}`);
        confidence -= 0.1;
      }
    }
  } catch {
    // Non-numeric kWh is already reflected by empty fields.
  }

  try {
    if (row.amount_due_usd && row.total_new_charges_usd) {
      if (Math.abs(Number(row.amount_due_usd) - Number(row.total_new_charges_usd)) > 0.02) {
        notes.push("amount_due != total_new_charges");
        confidence -= 0.05;
      }
    }
  } catch {
    // Leave confidence unchanged when the amounts are not numbers.
  }

  confidence = Math.max(0, Math.min(1, Math.round(confidence * 100) / 100));
  row.parse_confidence = confidence.toFixed(2);
  row.notes = notes.join("; ");
  return row;
}

function meterIdsIn(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/For meter\s+(\S+)/gi)].map((match) => match[1] ?? "").filter((id) => id !== ""),
    ),
  ];
}

function appendNote(notes: string, extra: string): string {
  return notes ? `${notes}; ${extra}` : extra;
}

/** Split a bill that repeats one Usage block per meter. Returns null when the layout is a single meter. */
function splitMeterSections(text: string, meterIds: string[]): string[] | null {
  if (meterIds.length <= 1) return null;
  const starts = [...text.matchAll(/Usage\s+Avg\.\s+cost\s+Total cost/g)].map((match) => match.index ?? 0);
  if (starts.length < meterIds.length) return null;
  const header = text.slice(0, starts[0] ?? 0);
  return meterIds.map((_, index) => {
    const start = starts[index] ?? 0;
    const end = starts[index + 1] ?? text.length;
    return header + text.slice(start, end);
  });
}

export function parseSceBills(text: string, sourceFile: string): BillDraft[] {
  const source = normalizeText(text);
  const meterIds = meterIdsIn(source);
  const sections = splitMeterSections(source, meterIds);
  if (sections) {
    return sections.map((section) => {
      const row = parseSceBill(section, sourceFile);
      row.notes = appendNote(row.notes, "multi-meter bill; row is this meter only");
      return row;
    });
  }

  const row = parseSceBill(source, sourceFile);
  if (meterIds.length <= 1) return [row];

  return meterIds.map((meterId, index) => {
    if (index === 0) {
      const first = { ...row, meter_id: meterId };
      first.notes = appendNote(first.notes, "multi-meter bill; row is this meter only");
      return first;
    }
    const extra = emptyBill(sourceFile);
    extra.utility = row.utility;
    extra.customer_name = row.customer_name;
    extra.customer_account = row.customer_account;
    extra.service_account = row.service_account;
    extra.meter_id = meterId;
    extra.parser_id = row.parser_id;
    extra.billing_period_start = row.billing_period_start;
    extra.billing_period_end = row.billing_period_end;
    extra.billing_days = row.billing_days;
    extra.parse_confidence = "0.25";
    extra.notes = "multi-meter bill; usage block not separated for this meter";
    return extra;
  });
}

export const sceParser: BillParser = {
  id: SCE_PARSER_ID,
  match(text: string): boolean {
    const source = normalizeText(text);
    const brand = /Southern California Edison/i.test(source) || /www\.sce\.com/i.test(source);
    return brand && /Customer account/i.test(source) && /Billing period:/i.test(source);
  },
  parse: parseSceBills,
};
