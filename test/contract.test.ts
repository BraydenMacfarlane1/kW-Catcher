import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCsv, toCsv } from "../src/csv";
import {
  CONTRACT_COLUMNS,
  CONTRACT_OPTIONAL,
  CONTRACT_RECOMMENDED,
  CONTRACT_REQUIRED,
  CSV_BOOKKEEPING_COLUMNS,
  SUN_DADDY_INGEST_CONTRACT,
  csvExportColumns,
  isIsoDate,
} from "../src/contract";
import { BILL_COLUMNS } from "../src/parsers/base";
import { parseSceBill, parseSceBills } from "../src/parsers/sce";

const seed = parseCsv(readFileSync(new URL("../seed/xu-holdings-sce-12mo.csv", import.meta.url), "utf8"));
const schemaSql = [
  readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0004_charge_components.sql", import.meta.url), "utf8"),
].join("\n");

function cents(value: string | undefined): number {
  if (!value) return 0;
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

function chargesReconcile(row: Record<string, string>): boolean {
  const parts = ["energy_charges_usd", "demand_charges_usd", "taxes_usd", "fees_usd", "other_charges_usd"];
  const sum = parts.reduce((total, column) => total + cents(row[column]), 0);
  return Math.abs(sum - cents(row.total_new_charges_usd)) <= 2;
}

describe(SUN_DADDY_INGEST_CONTRACT, () => {
  it("locks CSV export columns to the contract names", () => {
    const header = csvExportColumns();
    expect(new Set(BILL_COLUMNS)).toEqual(new Set(CONTRACT_COLUMNS));
    expect(BILL_COLUMNS).toHaveLength(CONTRACT_COLUMNS.length);
    expect(header.slice(0, BILL_COLUMNS.length)).toEqual([...BILL_COLUMNS]);
    expect(header.slice(BILL_COLUMNS.length)).toEqual([...CSV_BOOKKEEPING_COLUMNS]);
    expect(header).not.toContain("month_index");

    const exported = toCsv(header, [Object.fromEntries(header.map((column) => [column, ""]))]);
    expect(exported.split("\n")[0]?.split(",")).toEqual([...header]);
    for (const column of [...CONTRACT_REQUIRED, ...CONTRACT_RECOMMENDED, ...CONTRACT_OPTIONAL]) {
      expect(header).toContain(column);
    }
  });

  it("stores every contract column on the D1 bills table", () => {
    for (const column of CONTRACT_COLUMNS) {
      expect(schemaSql, column).toMatch(new RegExp(`\\b${column}\\s+TEXT\\b`));
    }
    expect(schemaSql).not.toMatch(/\bmonth_index\b/);
  });

  it("keeps the seed on the contract", () => {
    expect(Object.keys(seed[0] ?? {})).toEqual([...BILL_COLUMNS]);
    expect(seed).toHaveLength(12);
    const meters = new Set(seed.map((row) => row.meter_id));
    expect(meters).toEqual(new Set(["259000-081267"]));

    for (const row of seed) {
      expect(isIsoDate(row.billing_period_start ?? ""), row.source_file).toBe(true);
      expect(isIsoDate(row.billing_period_end ?? ""), row.source_file).toBe(true);
      expect(row.kwh_total, row.source_file).not.toBe("");
      expect(row.demand_kw_max, row.source_file).not.toBe("");
      expect(chargesReconcile(row), row.source_file).toBe(true);
      if (row.due_date) expect(isIsoDate(row.due_date), row.source_file).toBe(true);
      if (row.bill_prepared_date) expect(isIsoDate(row.bill_prepared_date), row.source_file).toBe(true);
    }

    const summer = seed.find((row) => row.source_file === "bill0-original.pdf");
    const winter = seed.find((row) => row.source_file === "bill3.pdf");
    expect(summer?.kwh_on_peak).toBe("1140");
    expect(summer?.kwh_super_off_peak).toBe("");
    expect(winter?.kwh_on_peak).toBe("");
    expect(winter?.kwh_super_off_peak).toBe("3109");
    expect(Number(summer?.kwh_on_peak) + Number(summer?.kwh_mid_peak) + Number(summer?.kwh_off_peak)).toBe(
      Number(summer?.kwh_total),
    );
  });

  it("parses the sample SCE bill into the required contract fields", () => {
    const text = readFileSync(new URL("./fixtures/bill0-unpdf.txt", import.meta.url), "utf8");
    const row = parseSceBill(text, "bill0-original.pdf");
    for (const column of CONTRACT_REQUIRED) {
      expect(Object.prototype.hasOwnProperty.call(row, column), column).toBe(true);
    }
    expect(isIsoDate(row.billing_period_start)).toBe(true);
    expect(isIsoDate(row.billing_period_end)).toBe(true);
    expect(row.kwh_total).toBe("5142");
    expect(row.demand_kw_max).toBe("23");
    expect(row.kwh_on_peak).toBe("1140");
    expect(row.kwh_mid_peak).toBe("102");
    expect(row.kwh_off_peak).toBe("3900");
    expect(row.kwh_super_off_peak).toBe("");
    expect(row.meter_id).toBe("259000-081267");
    expect(row.utility).toBe("SCE");
    expect(chargesReconcile(row)).toBe(true);

    const rows = parseSceBills(
      `${text}\nFor meter OTHER-METER from 07/30/26 to 08/27/26\nUsage Avg. cost Total cost\n200 kWh $10.00 Energy Charges\n$1.00 Demand Charges\n$1.00 Other credits/charges\n$12.00 Total\n`,
      "bill0-original.pdf",
    );
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.some((item) => item.kwh_total === "5142")).toBe(true);
    expect(rows.some((item) => item.kwh_total === String(5142 + 200))).toBe(false);
  });
});
