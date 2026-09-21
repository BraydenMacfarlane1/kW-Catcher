import { BILL_COLUMNS, type BillColumn } from "./parsers/base";

/** Sun Daddy maps these kW-Catcher names on ingest. Do not rename them. */
export const SUN_DADDY_INGEST_CONTRACT = "Sun Daddy ingest contract v1";

/** Always exported. Blank only when the bill has no such value. */
export const CONTRACT_REQUIRED = [
  "billing_period_start",
  "billing_period_end",
  "kwh_total",
  "demand_kw_max",
  "kwh_on_peak",
  "kwh_mid_peak",
  "kwh_off_peak",
  "kwh_super_off_peak",
] as const satisfies readonly BillColumn[];

/** Exported on every row. Blank when the parser did not find them. */
export const CONTRACT_RECOMMENDED = [
  "meter_id",
  "service_account",
  "customer_account",
  "utility",
  "rate_schedule",
  "service_address",
  "service_city",
  "service_state",
  "service_zip",
  "billing_days",
  "parse_confidence",
  "source_file",
  "parser_id",
] as const satisfies readonly BillColumn[];

/** Provenance kept on the row. `other_charges_usd` is the residual. */
export const CONTRACT_OPTIONAL = [
  "energy_charges_usd",
  "demand_charges_usd",
  "taxes_usd",
  "fees_usd",
  "other_charges_usd",
  "total_new_charges_usd",
  "amount_due_usd",
  "due_date",
  "bill_prepared_date",
  "line_items_json",
  "demand_kw_on_peak",
  "demand_kw_mid_peak",
  "demand_kw_off_peak",
  "demand_kw_super_off_peak",
  "notes",
  "pod_id",
  "rin",
  "service_voltage",
  "customer_name",
] as const satisfies readonly BillColumn[];

export const CONTRACT_COLUMNS = [
  ...CONTRACT_REQUIRED,
  ...CONTRACT_RECOMMENDED,
  ...CONTRACT_OPTIONAL,
] as const satisfies readonly BillColumn[];

/** Bookkeeping after the contract columns. Sun Daddy ignores these on ingest. */
export const CSV_BOOKKEEPING_COLUMNS = ["id", "site_id", "r2_key", "created_at", "status"] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function csvExportColumns(): readonly string[] {
  const bill = new Set<string>(BILL_COLUMNS);
  const contract = new Set<string>(CONTRACT_COLUMNS);
  const missing = CONTRACT_COLUMNS.filter((column) => !bill.has(column));
  const extra = BILL_COLUMNS.filter((column) => !contract.has(column));
  if (missing.length > 0 || extra.length > 0 || bill.size !== contract.size) {
    throw new Error(
      `${SUN_DADDY_INGEST_CONTRACT} drift. missing=${missing.join(",") || "-"} extra=${extra.join(",") || "-"}`,
    );
  }
  return [...BILL_COLUMNS, ...CSV_BOOKKEEPING_COLUMNS];
}

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
