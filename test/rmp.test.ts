import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sourceKeyFor } from "../src/db";
import { parseDocument } from "../src/parsers/registry";
import { RMP_PARSER_ID, parseRockyMountainBills, rockyMountainParser } from "../src/parsers/rmp";
import { sceParser } from "../src/parsers/sce";
import { extractPdfText, PdfPasswordError } from "../src/pdf";

const layout = readFileSync(new URL("./fixtures/rmp-combined-pdftotext.txt", import.meta.url), "utf8");
const sceText = readFileSync(new URL("./fixtures/bill0-unpdf.txt", import.meta.url), "utf8");
const PASSWORD = "302334080017";

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

interface ExpectedPeriod {
  start: string;
  end: string;
  days: string;
  kwh: string;
  demand: string;
}

function longToIso(value: string): string {
  const match = /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/.exec(value.trim());
  if (!match) return "";
  return `${match[3]}-${MONTHS[match[1] ?? ""]}-${String(Number(match[2])).padStart(2, "0")}`;
}

function expectedPeriods(): ExpectedPeriod[] {
  const lines = readFileSync(new URL("./fixtures/rmp-expected-periods.tsv", import.meta.url), "utf8")
    .trim()
    .split("\n")
    .slice(1);
  return lines.map((line) => {
    const [start, end, days, kwh, demand] = line.split("\t");
    return {
      start: longToIso(start ?? ""),
      end: longToIso(end ?? ""),
      days: days ?? "",
      kwh: (kwh ?? "").replaceAll(",", ""),
      demand: demand ?? "",
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

function expectIdentity(row: Record<string, string>): void {
  expect(row.utility).toBe("Rocky Mountain Power");
  expect(row.customer_name).toBe("J & J GALAXY PROPERTIES, LLC");
  expect(row.customer_account).toBe("30233408-0017");
  expect(row.meter_id).toBe("348224085");
  expect(row.service_address).toBe("2245 E TOMPKINS DR");
  expect(row.service_city).toBe("COTTONWOOD HEIGHTS");
  expect(row.service_state).toBe("UT");
  expect(row.service_zip).toBe("84121-3848");
  expect(row.rate_schedule).toBe("23");
  expect(row.parser_id).toBe(RMP_PARSER_ID);
  expect(row.kwh_on_peak).toBe("");
  expect(row.kwh_mid_peak).toBe("");
  expect(row.kwh_off_peak).toBe("");
  expect(row.kwh_super_off_peak).toBe("");
  expect(row.demand_kw_on_peak).toBe("");
  expect(row.demand_kw_mid_peak).toBe("");
  expect(row.demand_kw_off_peak).toBe("");
  expect(row.demand_kw_super_off_peak).toBe("");
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
    expect(row.amount_due_usd, period.start).not.toBe("");
    expect(row.amount_due_usd, period.start).toBe(row.total_new_charges_usd);
    expect(row.amount_due_usd, period.start).not.toBe("2703.25");
    expect(chargesReconcile(row), `${period.start} charges`).toBe(true);
    expectIdentity(row);
    expect(row.kwh_total).not.toBe(String(kwhSum));
  }
}

function statementBlock(index: number): string {
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const startName = names[index % 12] ?? "Jan";
  const endName = names[(index + 1) % 12] ?? "Feb";
  const startYear = 2024 + Math.floor(index / 12);
  const endYear = index % 12 === 11 ? startYear + 1 : startYear;
  const endLabel = `${endName} 1, ${endYear}`;
  return `BILLING DATE: ${endName} 18, ${endYear}
DUE DATE: ${endName} 28, ${endYear}
New Charges +${(300 + index).toFixed(2)}
Schedule 23
348224085 ${startName} 1, ${startYear} ${endLabel} 29 100 200 40.0 ${1000 + index} kwh
348224085 Demand ${endLabel} 0.200 40.0 ${index + 1} kw
NEW CHARGES
Basic Charge 10.00
Demand Charge ${index + 1} kw 8.1300000 8.13
Energy Charge ${1000 + index} kwh 0.1074680 100.00
Utah Sales Tax 0.0600000 6.00
Total New Charges ${(300 + index).toFixed(2)}
`;
}

describe("Rocky Mountain Power parser", () => {
  it("matches Rocky Mountain Power, the website, and PacifiCorp", () => {
    expect(rockyMountainParser.match("Rocky Mountain Power\nAccount 1")).toBe(true);
    expect(rockyMountainParser.match("Pay at RockyMountainPower.net")).toBe(true);
    expect(rockyMountainParser.match("PacifiCorp dba Rocky Mountain Power")).toBe(true);
    expect(rockyMountainParser.match(sceText)).toBe(false);
    expect(sceParser.match(layout)).toBe(false);
  });

  it("parses 12 service periods from pdftotext -layout", () => {
    expect(rockyMountainParser.match(layout)).toBe(true);
    const rows = parseRockyMountainBills(layout, "rmp-combined.pdf");
    expectPeriods(rows);
    const outcome = parseDocument(layout, "rmp-combined.pdf");
    expect(outcome.rows.map((row) => row.status)).toEqual(Array.from({ length: 12 }, () => "ok"));
    expectPeriods(outcome.rows.map((row) => row.fields));

    const latest = rows.find((row) => row.billing_period_start === "2026-02-17");
    expect(latest?.billing_period_end).toBe("2026-03-18");
    expect(latest?.kwh_total).toBe("10160");
    expect(latest?.demand_kw_max).toBe("27");
    expect(latest?.total_new_charges_usd).toBe("1210.50");
    expect(latest?.amount_due_usd).toBe("1210.50");
    expect(latest?.bill_prepared_date).toBe("2026-03-19");
    expect(latest?.due_date).toBe("2026-04-01");
    const items = JSON.parse(latest?.line_items_json ?? "[]") as { label: string; category: string }[];
    expect(items.some((item) => item.label.startsWith("Demand Charge") && item.category === "demand")).toBe(true);
    expect(items.some((item) => item.category === "tax")).toBe(true);
    expect(latest?.notes).toContain("non-TOU; usage in kwh_total");

    const keys = rows.map((row) => sourceKeyFor("site-1", row, "hash"));
    expect(new Set(keys).size).toBe(12);
    expect(keys.every((key) => key.startsWith("site-1|348224085|"))).toBe(true);
  });

  it("returns one row per service period instead of a fixed length", () => {
    const header = `Rocky Mountain Power
www.RockyMountainPower.net
J & J GALAXY PROPERTIES, LLC
2245 E TOMPKINS DR
COTTONWOOD HEIGHTS UT 84121-3848
ACCOUNT NUMBER: 30233408-001 7
`;
    for (const count of [2, 3, 13]) {
      const text = header + Array.from({ length: count }, (_, index) => statementBlock(index)).join("\n");
      const rows = parseRockyMountainBills(text, `${count}-periods.pdf`);
      expect(rows, `${count} periods`).toHaveLength(count);
      expect(new Set(rows.map((row) => row.billing_period_start)).size).toBe(count);
      const outcome = parseDocument(text, `${count}-periods.pdf`);
      expect(outcome.rows).toHaveLength(count);
      expect(outcome.rows.every((row) => row.status === "ok")).toBe(true);
      expect(outcome.rows.every((row) => row.fields.rate_schedule === "23")).toBe(true);
    }
  });

  it("unlocks the combined PDF with the account password and parses 12 rows", async () => {
    const bytes = new Uint8Array(readFileSync(new URL("./fixtures/rmp-combined.pdf", import.meta.url)));
    await expect(extractPdfText(bytes)).rejects.toBeInstanceOf(PdfPasswordError);
    await expect(extractPdfText(bytes)).rejects.toThrow(/needs_password/);
    try {
      await extractPdfText(bytes);
    } catch (error) {
      expect(error).toBeInstanceOf(PdfPasswordError);
      expect((error as PdfPasswordError).reason).toBe("missing");
    }

    await expect(extractPdfText(bytes.slice(), "not-the-password")).rejects.toThrow(/incorrect PDF password/);
    try {
      await extractPdfText(bytes.slice(), "not-the-password");
    } catch (error) {
      expect((error as PdfPasswordError).reason).toBe("incorrect");
    }

    const text = await extractPdfText(bytes.slice(), PASSWORD);
    const outcome = parseDocument(text, "rmp-combined.pdf");
    expect(outcome.rows).toHaveLength(12);
    expect(outcome.rows.every((row) => row.status === "ok")).toBe(true);
    expectPeriods(outcome.rows.map((row) => row.fields));
    const latest = outcome.rows.find((row) => row.fields.billing_period_start === "2026-02-17");
    expect(latest?.fields.total_new_charges_usd).toBe("1210.50");
    expect(latest?.fields.amount_due_usd).not.toBe("2703.25");
  });

  it("still reads an unencrypted PDF when a password is also supplied", async () => {
    const bytes = new Uint8Array(readFileSync(new URL("./fixtures/bill0-original.pdf", import.meta.url)));
    const text = await extractPdfText(bytes, "ignored-password");
    const outcome = parseDocument(text, "bill0-original.pdf");
    expect(outcome.rows[0]?.status).toBe("ok");
    expect(outcome.rows[0]?.fields.utility).toBe("SCE");
  });
});
