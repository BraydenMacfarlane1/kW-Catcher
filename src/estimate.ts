import type { BillRow } from "./db";
import { BILL_COLUMNS } from "./parsers/base";

/**
 * Estimated billing periods, Sun Daddy spec v1 (`neighbor_daily_avg_v1`).
 *
 * A port of estimateGaps.reference.mjs. Estimates are computed when a site is
 * exported or shown, from the meter's real `ok` rows. Nothing is stored, so an
 * estimate disappears as soon as the real bill for that period is uploaded.
 */
export const ESTIMATION_METHOD = "neighbor_daily_avg_v1";

const DAY = 86_400_000;
/** Sun Daddy detectBillSegmentGaps / interpolateGaps minimum. */
const MIN_GAP_DAYS = 3;
/** Sun Daddy BILL_PERIOD_LONG_DAYS. */
const LONG_DAYS = 45;

export interface EstimateInput {
  billing_period_start: string;
  billing_period_end: string;
  kwh_total: string | number | null;
  demand_kw_max: string | number | null;
}

export interface EstimatedPeriod<T extends EstimateInput = EstimateInput> {
  billing_period_start: string;
  billing_period_end: string;
  kwh_total: number;
  demand_kw_max: number | null;
  /** Inclusive gap days behind this piece's kWh. */
  gap_days: number;
  daily_kwh: number;
  use_handoff: boolean;
  prev: T;
  next: T;
}

/** An exported row: a stored bill, or an estimate built for export. */
export type ExportBill = BillRow & { estimated?: string; estimation_method?: string };

function ms(value: string): number {
  return Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
}

function iso(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** Inclusive day count, like Sun Daddy segmentDaySpan. */
function incDays(start: number, end: number): number {
  return Math.round((end - start) / DAY) + 1;
}

function num(value: string | number | null | undefined): number | null {
  if (value === "" || value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** rows: one meter's real ok rows. Returns the estimated periods to add. Math.round is half-up. */
export function estimateMissingPeriods<T extends EstimateInput>(rows: readonly T[]): EstimatedPeriod<T>[] {
  const real = rows
    .filter((row) => row.billing_period_start && row.billing_period_end)
    .map((row) => ({ row, s: ms(row.billing_period_start), e: ms(row.billing_period_end) }))
    .filter((entry) => Number.isFinite(entry.s) && Number.isFinite(entry.e) && entry.e >= entry.s)
    .sort((a, b) => a.s - b.s || a.e - b.e);
  const first = real[0];
  if (!first || real.length < 2) return [];

  let handoff = 0;
  let inclusive = 0;
  for (let index = 0; index < real.length - 1; index += 1) {
    const current = real[index];
    const following = real[index + 1];
    if (!current || !following) continue;
    if (following.s === current.e) handoff += 1;
    else if (following.s === current.e + DAY) inclusive += 1;
  }
  const useHandoff = handoff > inclusive;
  const cycle = Math.max(1, Math.round(median(real.map((entry) => incDays(entry.s, entry.e)))));

  const out: EstimatedPeriod<T>[] = [];
  let maxEnd = first.e;
  let prev = first;
  for (let index = 1; index < real.length; index += 1) {
    const next = real[index];
    if (!next) continue;
    const gapStart = maxEnd + DAY;
    const gapEnd = next.s - DAY;
    if (gapEnd >= gapStart && incDays(gapStart, gapEnd) >= MIN_GAP_DAYS) {
      const gapDays = incDays(gapStart, gapEnd);
      const prevKwh = num(prev.row.kwh_total);
      const nextKwh = num(next.row.kwh_total);
      if (prevKwh != null && nextKwh != null) {
        const daily = (prevKwh / incDays(prev.s, prev.e) + nextKwh / incDays(next.s, next.e)) / 2;
        const totalKwh = Math.round(gapDays * daily);
        const peaks = [num(prev.row.demand_kw_max), num(next.row.demand_kw_max)].filter(
          (value): value is number => value != null,
        );
        const peak = peaks.length ? Math.round((peaks.reduce((a, b) => a + b, 0) / peaks.length) * 100) / 100 : null;
        const pieces = Math.max(1, Math.round(gapDays / cycle), Math.ceil(gapDays / LONG_DAYS));
        const base = Math.floor(gapDays / pieces);
        const extra = gapDays - base * pieces;
        let cursor = gapStart;
        let used = 0;
        for (let piece = 0; piece < pieces; piece += 1) {
          const days = base + (piece < extra ? 1 : 0);
          const start = cursor;
          const end = cursor + (days - 1) * DAY;
          cursor = end + DAY;
          const kwh = piece === pieces - 1 ? totalKwh - used : Math.round(days * daily);
          used += kwh;
          const emittedStart = useHandoff ? (piece === 0 ? prev.e : start) : start;
          const emittedEnd = useHandoff ? (piece === pieces - 1 ? next.s : end + DAY) : end;
          out.push({
            billing_period_start: iso(emittedStart),
            billing_period_end: iso(emittedEnd),
            kwh_total: kwh,
            demand_kw_max: peak,
            gap_days: days,
            daily_kwh: Math.round(daily * 1000) / 1000,
            use_handoff: useHandoff,
            prev: prev.row,
            next: next.row,
          });
        }
      }
    }
    if (next.e > maxEnd) {
      maxEnd = next.e;
      prev = next;
    }
  }
  return out;
}

/** Copied from the meter's real row so Sun Daddy's meter consensus still holds. Everything else stays blank. */
const IDENTITY_COLUMNS = [
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
  "service_voltage",
] as const;

function estimatedRow(period: EstimatedPeriod<BillRow>): ExportBill {
  const prev = period.prev;
  const row = Object.fromEntries(BILL_COLUMNS.map((column) => [column, ""])) as Record<string, string>;
  for (const column of IDENTITY_COLUMNS) row[column] = prev[column] ?? "";
  row.billing_period_start = period.billing_period_start;
  row.billing_period_end = period.billing_period_end;
  // Days as this meter's bills count them: handoff meters print end - start, inclusive meters end - start + 1.
  const span = Math.round((ms(period.billing_period_end) - ms(period.billing_period_start)) / DAY);
  row.billing_days = String(period.use_handoff ? span : span + 1);
  row.kwh_total = String(period.kwh_total);
  row.demand_kw_max = period.demand_kw_max == null ? "" : period.demand_kw_max.toFixed(2);
  row.notes = `estimated from ${prev.billing_period_start} to ${prev.billing_period_end} and ${period.next.billing_period_start} to ${period.next.billing_period_end}`;
  // line_items_json stays "" (not "[]") so Sun Daddy treats the row as having no dollars.
  return {
    ...(row as unknown as BillRow),
    id: `estimated:${prev.meter_id}:${period.billing_period_start}:${period.billing_period_end}`,
    site_id: prev.site_id,
    r2_key: null,
    created_at: "",
    updated_at: "",
    status: "ok",
    source_key: "",
    text_excerpt: "",
    estimated: "true",
    estimation_method: ESTIMATION_METHOD,
  };
}

export function isEstimated(bill: ExportBill): boolean {
  return bill.estimated === "true";
}

/**
 * Real bills plus estimated rows for each meter's interior gaps, ordered like
 * listBills (meter_id, then billing_period_start). Only real `ok` rows with a
 * meter id feed the estimate. Real rows come back unchanged.
 */
export function withEstimatedRows(input: readonly ExportBill[]): ExportBill[] {
  // Idempotent: estimates are always recomputed from the real rows, never fed back in.
  const bills = input.filter((bill) => !isEstimated(bill));
  const byMeter = new Map<string, BillRow[]>();
  for (const bill of bills) {
    if (bill.status !== "ok" || !bill.meter_id) continue;
    const list = byMeter.get(bill.meter_id) ?? [];
    list.push(bill);
    byMeter.set(bill.meter_id, list);
  }
  const estimates: ExportBill[] = [];
  for (const rows of byMeter.values()) {
    for (const period of estimateMissingPeriods(rows)) estimates.push(estimatedRow(period));
  }
  if (estimates.length === 0) return bills;
  const key = (bill: BillRow): [string, string] => [bill.meter_id ?? "", bill.billing_period_start ?? ""];
  return [...bills, ...estimates].sort((a, b) => {
    const [meterA, startA] = key(a);
    const [meterB, startB] = key(b);
    if (meterA !== meterB) return meterA < meterB ? -1 : 1;
    if (startA !== startB) return startA < startB ? -1 : 1;
    return 0;
  });
}
