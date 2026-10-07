import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { BillRow } from "../src/db";
import { ESTIMATION_METHOD, estimateMissingPeriods, isEstimated, withEstimatedRows, type EstimateInput } from "../src/estimate";
import { billExportRecord } from "../src/export";
import { missingMonths, timelineRows } from "../src/gaps";
import { BILL_COLUMNS } from "../src/parsers/base";
import { parseDocument } from "../src/parsers/registry";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

interface GoldenPeriod {
  billing_period_start: string;
  billing_period_end: string;
  kwh_total: number;
  demand_kw_max: number | null;
  estimated: boolean;
  estimation_method: string;
  _gap_days: number;
  _daily_kwh: number;
}

/** Output of Sun Daddy's estimateGaps.reference.mjs on the same inputs (see "source" in the file). */
const GOLDEN = JSON.parse(fixture("estimate-golden.json")) as {
  mid: Record<string, GoldenPeriod[]>;
  synthetic: Record<string, { rows: EstimateInput[]; expected: GoldenPeriod[] }>;
};

function asGolden(rows: readonly EstimateInput[]): GoldenPeriod[] {
  return estimateMissingPeriods(rows).map((period) => ({
    billing_period_start: period.billing_period_start,
    billing_period_end: period.billing_period_end,
    kwh_total: period.kwh_total,
    demand_kw_max: period.demand_kw_max,
    estimated: true,
    estimation_method: ESTIMATION_METHOD,
    _gap_days: period.gap_days,
    _daily_kwh: period.daily_kwh,
  }));
}

function tsvRows(name: string): Record<string, string>[] {
  const [head = "", ...lines] = fixture(name).trim().split("\n");
  const columns = head.split("\t");
  return lines.map((line) => Object.fromEntries(columns.map((column, index) => [column, line.split("\t")[index] ?? ""])));
}

/** Stored rows in listBills order (meter, then period start). */
function storedBills(text: string): BillRow[] {
  const rows = parseDocument(text, "mid.pdf").rows.map(
    (row, index) =>
      ({
        ...row.fields,
        id: `bill-${index}`,
        site_id: "site-mid",
        r2_key: "sites/site-mid/mid.pdf",
        created_at: "2026-10-07T16:53:00.000Z",
        updated_at: "2026-10-07T16:53:00.000Z",
        status: row.status,
        source_key: `site-mid|${row.fields.meter_id}|${row.fields.billing_period_start}|${row.fields.billing_period_end}`,
        text_excerpt: "",
      }) as BillRow,
  );
  const key = (bill: BillRow) => `${bill.meter_id}|${bill.billing_period_start}`;
  return rows.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

const DOLLAR_COLUMNS = [
  "energy_charges_usd",
  "demand_charges_usd",
  "taxes_usd",
  "fees_usd",
  "other_charges_usd",
  "total_new_charges_usd",
  "amount_due_usd",
  "electric_total_usd",
  "non_electric_charges_usd",
  "energy_demand_combined_usd",
  "charges_tax_inclusive",
  "embedded_tax_rate",
] as const;

describe("estimated billing periods (neighbor_daily_avg_v1)", () => {
  it("matches the reference implementation on the MID expected rows", () => {
    const byMeter = new Map<string, Record<string, string>[]>();
    for (const row of tsvRows("mid-expected.tsv")) {
      const list = byMeter.get(row.meter_id ?? "") ?? [];
      list.push(row);
      byMeter.set(row.meter_id ?? "", list);
    }
    expect([...byMeter.keys()].sort()).toEqual(Object.keys(GOLDEN.mid).sort());
    for (const [meterId, rows] of byMeter) {
      expect(asGolden(rows as unknown as EstimateInput[]), meterId).toEqual(GOLDEN.mid[meterId]);
    }
  });

  for (const [name, vector] of Object.entries(GOLDEN.synthetic)) {
    it(`matches the reference implementation: ${name}`, () => {
      expect(asGolden(vector.rows)).toEqual(vector.expected);
    });
  }

  it("fills the missing MID 07/22/26-08/20/26 bill on each meter with the spec check values", () => {
    const bills = storedBills(fixture("mid-2025-2026-unpdf.txt"));
    expect(bills).toHaveLength(33);
    const all = withEstimatedRows(bills);
    expect(all).toHaveLength(36);
    const estimated = all.filter(isEstimated).map((bill) => billExportRecord(bill));
    expect(
      estimated.map((row) => [
        row.meter_id,
        row.service_account,
        row.rate_schedule,
        row.billing_period_start,
        row.billing_period_end,
        row.billing_days,
        row.kwh_total,
        row.demand_kw_max,
        row.estimated,
        row.estimation_method,
        row.status,
      ]),
    ).toEqual([
      ["900001", "9000000012", "GS-2", "2026-07-22", "2026-08-20", "29", "7833", "61.93", "true", ESTIMATION_METHOD, "ok"],
      ["900002", "9000000013", "GS-2", "2026-07-22", "2026-08-20", "29", "4242", "42.50", "true", ESTIMATION_METHOD, "ok"],
      ["900003", "9000000015", "GS-1", "2026-07-22", "2026-08-20", "29", "243", "0.83", "true", ESTIMATION_METHOD, "ok"],
    ]);
    for (const row of estimated) {
      for (const column of ["kwh_on_peak", "kwh_mid_peak", "kwh_off_peak", "kwh_super_off_peak", ...DOLLAR_COLUMNS]) {
        expect({ column, value: row[column] }).toEqual({ column, value: "" });
      }
      expect(row.line_items_json).toBe("");
      expect(row.utility).toBe("Modesto Irrigation District");
      expect(row.customer_name).toBe("MODESTO COVENANT CHURCH");
      expect(row.service_address).not.toBe("");
      expect(row.source_file).toBe("");
      expect(row.r2_key).toBe("");
      expect(row.notes).toBe("estimated from 2026-06-19 to 2026-07-22 and 2026-08-20 to 2026-09-21");
    }

    // Real rows come back as the same objects, in listBills order, with estimated=false.
    expect(all.filter((bill) => !isEstimated(bill))).toEqual(bills);
    for (const bill of bills) {
      const record = billExportRecord(bill);
      expect(record.estimated).toBe("false");
      expect(record.estimation_method).toBe("");
      for (const column of BILL_COLUMNS) expect(record[column]).toBe(bill[column]);
    }
    const order = all.map((bill) => `${bill.meter_id}|${bill.billing_period_start}`);
    expect(order).toEqual([...order].sort());
    const meter1 = all.filter((bill) => bill.meter_id === "900001").map((bill) => bill.billing_period_start);
    expect(meter1.slice(9, 12)).toEqual(["2026-06-19", "2026-07-22", "2026-08-20"]);
  });

  it("ignores gaps under 3 days and never fills before the first or after the last bill", () => {
    expect(GOLDEN.synthetic.gap_under_3_days_ignored?.expected).toEqual([]);
    expect(asGolden(GOLDEN.synthetic.gap_under_3_days_ignored?.rows ?? [])).toEqual([]);
    expect(asGolden(GOLDEN.synthetic.single_row_no_edges?.rows ?? [])).toEqual([]);
    const spec = asGolden(GOLDEN.synthetic.spec_inclusive_61_day_split?.rows ?? []);
    expect(spec.every((row) => row.billing_period_start > "2025-01-01" && row.billing_period_end < "2025-06-30")).toBe(true);
  });

  it("splits a gap over 45 days into bill-length pieces that sum to the whole-gap kWh", () => {
    const spec = asGolden(GOLDEN.synthetic.spec_inclusive_61_day_split?.rows ?? []);
    expect(spec.map((row) => [row.billing_period_start, row.billing_period_end, row.kwh_total, row.demand_kw_max])).toEqual([
      ["2025-03-01", "2025-03-31", 4650, 26],
      ["2025-04-01", "2025-04-30", 4500, 26],
    ]);
    const handoff = asGolden(GOLDEN.synthetic.handoff_long_gap_split?.rows ?? []);
    expect(handoff.map((row) => [row.billing_period_start, row.billing_period_end])).toEqual([
      ["2025-03-12", "2025-04-12"],
      ["2025-04-12", "2025-05-12"],
      ["2025-05-12", "2025-06-10"],
    ]);
    const whole = Math.round(89 * ((3000 / 31 + 6000 / 31) / 2));
    expect(handoff.reduce((total, row) => total + row.kwh_total, 0)).toBe(whole);
  });

  it("rounds kWh half up, not to even", () => {
    // daily = (30/30 + 60/30) / 2 = 1.5; 3 gap days = 4.5 -> 5 (banker's rounding would give 4).
    const [row] = asGolden(GOLDEN.synthetic.half_up_rounding?.rows ?? []);
    expect(row?.kwh_total).toBe(5);
  });

  it("uses the one neighbor peak that exists, and leaves demand blank when neither has one", () => {
    const rows = asGolden(GOLDEN.synthetic.missing_neighbor_peak?.rows ?? []);
    expect(rows.map((row) => row.demand_kw_max)).toEqual([18.4, 18.4]);
    const none = estimateMissingPeriods([
      { billing_period_start: "2025-01-01", billing_period_end: "2025-01-31", kwh_total: "310", demand_kw_max: "" },
      { billing_period_start: "2025-03-01", billing_period_end: "2025-03-31", kwh_total: "310", demand_kw_max: null },
    ]);
    expect(none.map((row) => row.demand_kw_max)).toEqual([null]);
    expect(asGolden(GOLDEN.synthetic.missing_neighbor_kwh_skips_gap?.rows ?? [])).toEqual([]);
  });

  it("feeds only real ok rows with a meter id into the estimate", () => {
    const bills = storedBills(fixture("mid-2025-2026-unpdf.txt"));
    const failedJune = bills.map((bill) =>
      bill.meter_id === "900001" && bill.billing_period_start === "2026-06-19"
        ? { ...bill, status: "failed" as const, notes: "needs_review: test" }
        : bill,
    );
    const estimated = withEstimatedRows(failedJune).filter(isEstimated);
    const meter1 = estimated.filter((bill) => bill.meter_id === "900001");
    // With June excluded, the 61-day gap runs from the May bill's end to the Aug bill's start and is
    // split in two (values checked against estimateGaps.reference.mjs on the same rows).
    expect(meter1.map((bill) => [bill.billing_period_start, bill.billing_period_end, bill.kwh_total, bill.demand_kw_max])).toEqual([
      ["2026-06-19", "2026-07-21", "8849", "63.87"],
      ["2026-07-21", "2026-08-20", "8564", "63.87"],
    ]);
    expect(withEstimatedRows(withEstimatedRows(bills)).filter(isEstimated)).toHaveLength(3);
  });

  it("keeps estimated rows out of the month-based gap check", () => {
    const real = [
      { billing_period_start: "2025-01-01", billing_period_end: "2025-01-31", kwh_total: "3100", demand_kw_max: "10" },
      { billing_period_start: "2025-03-01", billing_period_end: "2025-03-31", kwh_total: "3100", demand_kw_max: "10" },
    ];
    const [period] = estimateMissingPeriods(real);
    expect(period?.billing_period_start).toBe("2025-02-01");
    const withEstimate = [...real, { ...real[0], ...period, estimated: "true" }] as typeof real;
    expect(missingMonths(real)).toEqual(["2025-02"]);
    const timeline = timelineRows(withEstimate, real);
    expect(timeline.filter((row) => row.kind === "gap").map((row) => (row.kind === "gap" ? row.month : ""))).toEqual(["2025-02"]);
    expect(timeline.filter((row) => row.kind === "bill")).toHaveLength(3);
  });
});
