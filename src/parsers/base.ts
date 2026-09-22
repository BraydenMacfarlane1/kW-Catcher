/** Bill fields for Sun Daddy ingest contract v1. Names are fixed; see src/contract.ts. */
export const BILL_COLUMNS = [
  "utility",
  "customer_name",
  "customer_account",
  "service_account",
  "meter_id",
  "pod_id",
  "service_address",
  "service_city",
  "service_state",
  "service_zip",
  "rate_schedule",
  "rin",
  "billing_period_start",
  "billing_period_end",
  "billing_days",
  "kwh_total",
  "kwh_on_peak",
  "kwh_mid_peak",
  "kwh_off_peak",
  "kwh_super_off_peak",
  "demand_kw_max",
  "demand_kw_on_peak",
  "demand_kw_mid_peak",
  "demand_kw_off_peak",
  "demand_kw_super_off_peak",
  "energy_charges_usd",
  "demand_charges_usd",
  "taxes_usd",
  "fees_usd",
  "other_charges_usd",
  "total_new_charges_usd",
  "amount_due_usd",
  "due_date",
  "bill_prepared_date",
  "service_voltage",
  "source_file",
  "parser_id",
  "parse_confidence",
  "notes",
  "line_items_json",
] as const;

export type BillColumn = (typeof BILL_COLUMNS)[number];
export type BillDraft = Record<BillColumn, string>;

export const REQUIRED_FIELDS = [
  "customer_account",
  "amount_due_usd",
  "kwh_total",
  "billing_period_start",
  "billing_period_end",
] as const satisfies readonly BillColumn[];

export type BillStatus = "ok" | "needs_parser" | "failed";

export interface BillParser {
  id: string;
  match(text: string): boolean;
  /** One row per meter per billing period. Do not combine kWh or demand across meters or periods. */
  parse(text: string, sourceFile: string): BillDraft[];
}

export interface ParsedRow {
  status: BillStatus;
  fields: BillDraft;
}

export interface ParseOutcome {
  rows: ParsedRow[];
  textExcerpt: string;
}

export function emptyBill(sourceFile = ""): BillDraft {
  const row = Object.fromEntries(BILL_COLUMNS.map((column) => [column, ""])) as BillDraft;
  row.source_file = sourceFile;
  row.line_items_json = "[]";
  return row;
}

export function excerpt(text: string, limit = 2000): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return trimmed.slice(0, limit);
}

export function missingRequired(fields: BillDraft): BillColumn[] {
  return REQUIRED_FIELDS.filter((field) => !fields[field]);
}
