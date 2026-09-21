import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sourceKeyFor } from "../src/db";
import { parseDocument } from "../src/parsers/registry";
import { NV_ENERGY_PARSER_ID, nvEnergyParser, parseNvEnergyBills } from "../src/parsers/nvenergy";
import { SCE_PARSER_ID, sceParser } from "../src/parsers/sce";
import { extractPdfText } from "../src/pdf";

const layout = readFileSync(new URL("./fixtures/nv-energy-combined-pdftotext.txt", import.meta.url), "utf8");
const page1 = readFileSync(new URL("./fixtures/nv-energy-page1.txt", import.meta.url), "utf8");
const sceText = readFileSync(new URL("./fixtures/bill0-unpdf.txt", import.meta.url), "utf8");

interface ExpectedPeriod {
  start: string;
  end: string;
  days: string;
  kwh: string;
  demand: string;
  total: string;
  due: string;
  billed: string;
}

const MONTHS: Record<string, string> = {
  Jan: "01",
  Feb: "02",
  Mar: "03",
  Apr: "04",
  May: "05",
  Jun: "06",
  Jul: "07",
  Aug: "08",
  Sep: "09",
  Oct: "10",
  Nov: "11",
  Dec: "12",
};

function mdyToIso(value: string): string {
  const [month, day, year] = value.split("/");
  return `20${year}-${month}-${day}`;
}

function longToIso(value: string): string {
  const match = /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/.exec(value.trim());
  if (!match) return "";
  return `${match[3]}-${MONTHS[match[1] ?? ""]}-${String(Number(match[2])).padStart(2, "0")}`;
}

function expectedPeriods(): ExpectedPeriod[] {
  const lines = readFileSync(new URL("./fixtures/nv-energy-expected-periods.tsv", import.meta.url), "utf8")
    .trim()
    .split("\n")
    .slice(1);
  return lines.map((line) => {
    const [start, end, days, kwh, demand, , total, due, billed] = line.split("\t");
    return {
      start: mdyToIso(start ?? ""),
      end: mdyToIso(end ?? ""),
      days: days ?? "",
      kwh: (kwh ?? "").replaceAll(",", ""),
      demand: demand ?? "",
      total: total ?? "",
      due: longToIso(due ?? ""),
      billed: longToIso(billed ?? ""),
    };
  });
}

function chargeCents(value: string | undefined): number {
  if (!value) return 0;
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

function chargesReconcile(row: Record<string, string>): boolean {
  const parts = ["energy_charges_usd", "demand_charges_usd", "taxes_usd", "fees_usd", "other_charges_usd"];
  const sum = parts.reduce((total, column) => total + chargeCents(row[column]), 0);
  return Math.abs(sum - chargeCents(row.total_new_charges_usd)) <= 2;
}

function expectPeriods(fields: Record<string, string>[]): void {
  const expected = expectedPeriods();
  expect(fields).toHaveLength(expected.length);
  const kwhSum = expected.reduce((total, period) => total + Number(period.kwh), 0);
  for (const [index, period] of expected.entries()) {
    const row = fields[index] ?? {};
    expect(row.billing_period_start, period.start).toBe(period.start);
    expect(row.billing_period_end, period.start).toBe(period.end);
    expect(row.billing_days, period.start).toBe(period.days);
    expect(row.kwh_total, period.start).toBe(period.kwh);
    expect(row.demand_kw_max, period.start).toBe(period.demand);
    expect(row.total_new_charges_usd, period.start).toBe(period.total);
    expect(row.amount_due_usd, period.start).toBe(period.total);
    expect(row.due_date, period.start).toBe(period.due);
    expect(row.bill_prepared_date, period.start).toBe(period.billed);
    expect(row.utility).toBe("NV Energy");
    expect(row.customer_name).toBe("BUMBLE OFFICE LLC");
    expect(row.customer_account).toBe("3000397631416863744");
    expect(row.meter_id).toBe("AA034564104");
    expect(row.service_account).toBe("1686374");
    expect(row.rate_schedule).toBe("LGS - 1");
    expect(row.service_address).toBe("2960 W SAHARA AVE");
    expect(row.service_city).toBe("LAS VEGAS");
    expect(row.service_state).toBe("NV");
    expect(row.service_zip).toBe("89102");
    expect(row.kwh_on_peak).toBe("");
    expect(row.kwh_mid_peak).toBe("");
    expect(row.kwh_off_peak).toBe("");
    expect(row.kwh_super_off_peak).toBe("");
    expect(row.demand_kw_on_peak).toBe("");
    expect(row.demand_kw_mid_peak).toBe("");
    expect(row.demand_kw_off_peak).toBe("");
    expect(row.demand_kw_super_off_peak).toBe("");
    expect(row.parser_id).toBe(NV_ENERGY_PARSER_ID);
    expect(row.kwh_total).not.toBe(String(kwhSum));
    expect(chargesReconcile(row), period.start).toBe(true);
    expect(row.other_charges_usd, period.start).toBe("0.00");
    expect(row.taxes_usd, period.start).toBe("0.00");
  }
}

describe("NV Energy parser", () => {
  it("matches NV Energy wording and leaves SCE bills to the SCE parser", () => {
    expect(nvEnergyParser.match("NV Energy\nAccount: 1")).toBe(true);
    expect(nvEnergyParser.match("NVEnergy bill")).toBe(true);
    expect(nvEnergyParser.match("see nvenergy.com/rates")).toBe(true);
    expect(nvEnergyParser.match(sceText)).toBe(false);
    expect(sceParser.match(layout)).toBe(false);
    const sce = parseDocument(sceText, "bill0-original.pdf");
    expect(sce.rows).toHaveLength(1);
    expect(sce.rows[0]?.status).toBe("ok");
    expect(sce.rows[0]?.fields.parser_id).toBe(SCE_PARSER_ID);
    expect(sce.rows[0]?.fields.utility).toBe("SCE");
  });

  it("parses 11 periods from pdftotext -layout of the combined PDF", () => {
    expect(nvEnergyParser.match(layout)).toBe(true);
    const rows = parseNvEnergyBills(layout, "combined-bills.pdf");
    expectPeriods(rows);
    const outcome = parseDocument(layout, "combined-bills.pdf");
    expect(outcome.rows.map((row) => row.status)).toEqual(Array.from({ length: 11 }, () => "ok"));
    expectPeriods(outcome.rows.map((row) => row.fields));

    const first = rows[0];
    expect(first?.energy_charges_usd).toBe("4893.09");
    expect(first?.demand_charges_usd).toBe("790.00");
    expect(first?.fees_usd).toBe("1277.17");
    const items = JSON.parse(first?.line_items_json ?? "[]") as { label: string; amount_usd: string; category: string }[];
    expect(items.find((item) => item.label === "Electric Consumption")?.category).toBe("energy");
    expect(items.find((item) => item.label === "Demand Charge")?.category).toBe("demand");
    expect(items.find((item) => item.label === "Facility Charge")?.category).toBe("fee");
    expect(items.find((item) => item.label === "Local Government Fee")?.category).toBe("fee");
    expect(items.find((item) => item.label === "Renewable Energy Program")?.amount_usd).toBe("-14.64");

    const splitRate = rows.find((row) => row.billing_period_start === "2025-09-09");
    expect(splitRate?.demand_kw_max).toBe("");
    expect(splitRate?.demand_charges_usd).toBe("605.62");
    expect(splitRate?.notes).toContain("no single Demand Charge kW");
    expect(splitRate?.notes).toContain("multi-statement pdf; row is this billing period only");

    const keys = rows.map((row) => sourceKeyFor("site-1", row, "hash"));
    expect(new Set(keys).size).toBe(11);
    expect(keys.every((key) => key.startsWith("site-1|AA034564104|"))).toBe(true);
  });

  it("parses the combined PDF through unpdf into the same 11 periods", async () => {
    const bytes = new Uint8Array(readFileSync(new URL("./fixtures/nv-energy-combined.pdf", import.meta.url)));
    const text = await extractPdfText(bytes);
    const outcome = parseDocument(text, "combined-bills.pdf");
    expect(outcome.rows).toHaveLength(11);
    expect(outcome.rows.every((row) => row.status === "ok")).toBe(true);
    expectPeriods(outcome.rows.map((row) => row.fields));
  });

  it("parses one statement as a single row and does not invent TOU buckets", () => {
    const rows = parseNvEnergyBills(page1, "page1.pdf");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.billing_period_start).toBe("2025-05-09");
    expect(rows[0]?.billing_period_end).toBe("2025-06-10");
    expect(rows[0]?.kwh_total).toBe("73206");
    expect(rows[0]?.demand_kw_max).toBe("158.000");
    expect(rows[0]?.kwh_on_peak).toBe("");
    expect(rows[0]?.amount_due_usd).toBe("6960.26");
    expect(rows[0]?.notes).not.toContain("multi-statement");
    expect(parseDocument(page1, "page1.pdf").rows.map((row) => row.status)).toEqual(["ok"]);
  });

  it("keeps two billing periods separate when they share one meter", () => {
    const text = `NV Energy
BUMBLE OFFICE LLC
2960 W SAHARA AVE
LAS VEGAS, NV 89102
Account: 3000397631416863744
Electric Usage: LGS - 1
PAGE 1 OF 2
Meter Number: AA034564104
KWH 05/09/25 to 06/10/25 32 635 879 300 100
Charge Details
Electric Consumption 100.000 kWh x 0.10000 $10.00
Total Electric Service Amount $10.00
Amount Due By: Jul 01, 2025
Billing Date: Jun 13, 2025
PAGE 2 OF 2
PAGE 1 OF 1
Meter Number: AA034564104
KWH 06/10/25 to 07/10/25 30 879 1143 300 250
Charge Details
Electric Consumption 250.000 kWh x 0.10000 $25.00
Total Electric Service Amount $25.00
Amount Due By: Jul 31, 2025
Billing Date: Jul 15, 2025
`;
    const rows = parseNvEnergyBills(text, "two-periods.pdf");
    expect(rows.map((row) => row.kwh_total)).toEqual(["100", "250"]);
    expect(rows.map((row) => row.billing_period_start)).toEqual(["2025-05-09", "2025-06-10"]);
    expect(rows.map((row) => row.amount_due_usd)).toEqual(["10.00", "25.00"]);
    expect(rows.some((row) => row.kwh_total === "350")).toBe(false);
    expect(rows.every((row) => row.demand_kw_max === "")).toBe(true);
    expect(rows.every((row) => row.kwh_on_peak === "")).toBe(true);
  });

  it("parses a single-month bill that has no PAGE 1 OF marker", () => {
    const text = `www.nvenergy.com
BUMBLE OFFICE LLC
10 MAIN ST
LAS VEGAS, NV 89102
Account Number: 3000397631416863744
Electric Usage: LGS-1
Meter Number: AA034564104
KWH 01/09/26 to 02/09/26 31 1 2 300 400
Charge Details
Electric Consumption 400.000 kWh x 0.05000 $20.00
Total Electric Service Amount $20.00
Amount Due By: Mar 03, 2026
Billing Date: Feb 13, 2026
`;
    const rows = parseNvEnergyBills(text, "one-month.pdf");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kwh_total).toBe("400");
    expect(rows[0]?.rate_schedule).toBe("LGS - 1");
    expect(rows[0]?.service_address).toBe("10 MAIN ST");
    expect(rows[0]?.billing_period_start).toBe("2026-01-09");
    expect(rows[0]?.due_date).toBe("2026-03-03");
    expect(rows[0]?.kwh_mid_peak).toBe("");
    expect(parseDocument(text, "one-month.pdf").rows[0]?.status).toBe("ok");
  });
});
