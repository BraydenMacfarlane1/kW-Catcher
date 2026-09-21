import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/csv";
import { missingMonths, timelineRows } from "../src/gaps";

const csv = parseCsv(readFileSync(new URL("../seed/xu-holdings-sce-12mo.csv", import.meta.url), "utf8"));

describe("gap detection", () => {
  it("finds no missing months in the 12-month SCE history", () => {
    expect(missingMonths(csv.map((row) => ({
      billing_period_start: row.billing_period_start ?? "",
      billing_period_end: row.billing_period_end ?? "",
    })))).toEqual([]);
  });

  it("flags February when the bill that covers it is removed", () => {
    const periods = csv
      .filter((row) => row.billing_period_start !== "2026-01-29")
      .map((row) => ({
        billing_period_start: row.billing_period_start ?? "",
        billing_period_end: row.billing_period_end ?? "",
      }));
    expect(missingMonths(periods)).toEqual(["2026-02"]);
  });

  it("inserts a gap row between dated bills", () => {
    const rows = timelineRows([
      { id: "a", billing_period_start: "2026-01-01", billing_period_end: "2026-01-31" },
      { id: "b", billing_period_start: "2026-03-01", billing_period_end: "2026-03-31" },
    ]);
    expect(rows.map((row) => (row.kind === "gap" ? row.month : row.bill.id))).toEqual(["a", "2026-02", "b"]);
  });
});
