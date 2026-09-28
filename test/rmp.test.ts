import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sourceKeyFor } from "../src/db";
import { faxQuarterTurns } from "../src/fax";
import { embeddedPageQuarterTurn } from "../src/ocr";
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

interface ExpectedCharges {
  meter: string;
  start: string;
  end: string;
  energy: string;
  demand: string;
  fees: string;
  taxes: string;
  total: string;
}

interface ParsedLine {
  label: string;
  amount_usd: string;
  category: string;
}

function expectedCharges(): ExpectedCharges[] {
  return readFileSync(new URL("./fixtures/rmp-ifly-6a-expected-charges.tsv", import.meta.url), "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const [meter, start, end, energy, demand, fees, taxes, total] = line.split("\t");
      return {
        meter: meter ?? "",
        start: start ?? "",
        end: end ?? "",
        energy: energy ?? "",
        demand: demand ?? "",
        fees: fees ?? "",
        taxes: taxes ?? "",
        total: total ?? "",
      };
    });
}

function lineItems(row: { line_items_json: string } | undefined): ParsedLine[] {
  return JSON.parse(row?.line_items_json ?? "[]") as ParsedLine[];
}

function expectLine(items: ParsedLine[], amount: string, category: string, label: RegExp): void {
  const match = items.find((item) => item.amount_usd === amount);
  expect(match, amount).toMatchObject({ category, amount_usd: amount });
  expect(match?.label, amount).toMatch(label);
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

  it("reads Schedule 6 OCR text and keeps New Charges instead of the equal-payment installment", () => {
    const page1 = `Rocky Mountain Power
MILLCREEK REHAB AND NURSING
BILLING DATE: Feb 10, 2025
ACCOUNT NUMBER: 26317550-001 0
Equal Payment Plan
Payment Plan Amount +3,826.00 New Charges +5,327.45
Amount Due $3,826.00 Current Account Balance $8,850.77
ITEM 1 - ELECTRIC SERVICE 3520 S Highland Dr Millcreek UT
Ct Meter Schedule 6
348202960 |Jan9,2025 Feb 7,2025 13171 14449 [00 | 51,120 kwh
348202960 | Demand Feb 7, 2025 |] 2.904 [00 | 116 kw
NEW CHARGES
Basic Charge - 3P 53.00
Demand Charge - Winter 116 kw 11.7400000 1,361.84
Facilities Charge 116 kw 3.9900000 462.84
Energy Charge - Winter 51,120 kwh 0.0344050 1,758.78
Date Due: Mar 4, 2025
MILLCREEK UT 84106-3211
`;
    const page2 = page1
      .replace("Feb 10, 2025", "Mar 11, 2025")
      .replace("New Charges +5,327.45", "New Charges +5,178.07")
      .replace("Amount Due $3,826.00", "Amount Due $3,826.00")
      .replace("Jan 9, 2025 Feb 7, 2025", "Feb 7, 2025 Mar 10, 2025")
      .replace("|Jan9,2025 Feb 7,2025", "|Feb7,2025 Mar 10,2025")
      .replace("51,120 kwh", "50,360 kwh")
      .replace("Demand Feb 7, 2025", "Demand Mar 10, 2025")
      .replace("116 kw", "90 kw")
      .replace("Date Due: Mar 4, 2025", "Date Due: Apr 2, 2025");
    const rows = parseRockyMountainBills(`${page1}\n----- PAGE -----\n${page2}`, "scan.pdf");
    expect(rows).toHaveLength(2);
    const first = rows[0];
    expect(first?.billing_period_start).toBe("2025-01-09");
    expect(first?.billing_period_end).toBe("2025-02-07");
    expect(first?.billing_days).toBe("29");
    expect(first?.kwh_total).toBe("51120");
    expect(first?.demand_kw_max).toBe("116");
    expect(first?.rate_schedule).toBe("6");
    expect(first?.meter_id).toBe("348202960");
    expect(first?.customer_name).toBe("MILLCREEK REHAB AND NURSING");
    expect(first?.customer_account).toBe("26317550-0010");
    expect(first?.service_address).toBe("3520 S HIGHLAND DR");
    expect(first?.service_city).toBe("MILLCREEK");
    expect(first?.service_state).toBe("UT");
    expect(first?.service_zip).toBe("84106-3211");
    expect(first?.total_new_charges_usd).toBe("5327.45");
    expect(first?.amount_due_usd).toBe("5327.45");
    expect(first?.amount_due_usd).not.toBe("3826.00");
    expect(first?.bill_prepared_date).toBe("2025-02-10");
    expect(first?.due_date).toBe("2025-03-04");
    expect(first?.kwh_on_peak).toBe("");
    expect(first?.notes).toContain("equal payment plan");
    expect(rows[1]?.billing_period_start).toBe("2025-02-07");
    expect(rows[1]?.kwh_total).toBe("50360");
    expect(rows[1]?.total_new_charges_usd).toBe("5178.07");
    expect(rows[1]?.rate_schedule).toBe("6");
    const outcome = parseDocument(`${page1}\n${page2}`, "scan.pdf");
    expect(outcome.rows.every((row) => row.status === "ok")).toBe(true);
  });

  it("still reads an unencrypted PDF when a password is also supplied", async () => {
    const bytes = new Uint8Array(readFileSync(new URL("./fixtures/bill0-original.pdf", import.meta.url)));
    const text = await extractPdfText(bytes, "ignored-password");
    const outcome = parseDocument(text, "bill0-original.pdf");
    expect(outcome.rows[0]?.status).toBe("ok");
    expect(outcome.rows[0]?.fields.utility).toBe("SCE");
  });

  it("OCRs the scanned Schedule 6 PDF into a January 2025 row", async () => {
    const bytes = new Uint8Array(readFileSync(new URL("./fixtures/rmp-schedule6-scanned.pdf", import.meta.url)));
    const text = await extractPdfText(bytes);
    expect(text.length).toBeGreaterThan(40);
    const outcome = parseDocument(text, "rmp-schedule6-scanned.pdf");
    expect(outcome.rows.length).toBeGreaterThan(0);
    expect(outcome.rows.length).toBeLessThanOrEqual(11);
    const january = outcome.rows.find((row) => row.fields.billing_period_start === "2025-01-09");
    expect(january?.status).toBe("ok");
    expect(january?.fields.billing_period_end).toBe("2025-02-07");
    expect(january?.fields.kwh_total).toBe("51120");
    expect(january?.fields.demand_kw_max).toBe("116");
    expect(january?.fields.meter_id).toBe("348202960");
    expect(january?.fields.rate_schedule).toBe("6");
    expect(january?.fields.customer_account).toBe("26317550-0010");
    expect(january?.fields.total_new_charges_usd).toBe("5327.45");
    expect(january?.fields.amount_due_usd).not.toBe("3826.00");
    expect(january?.fields.kwh_on_peak).toBe("");
    const starts = outcome.rows.map((row) => row.fields.billing_period_start);
    expect(new Set(starts).size).toBe(starts.length);
  }, 180_000);

  it("turns duplex sideways fax pages and leaves an upright Schedule 6 scan alone", async () => {
    const terra = new Uint8Array(readFileSync(new URL("./fixtures/rmp-terra-sideways.pdf", import.meta.url)));
    const turns = faxQuarterTurns(terra);
    expect(turns).toHaveLength(24);
    expect(turns?.every((turn, index) => turn === (index % 2 === 0 ? 90 : 270))).toBe(true);

    const upright = new Uint8Array(readFileSync(new URL("./fixtures/rmp-schedule6-scanned.pdf", import.meta.url)));
    expect(faxQuarterTurns(upright)).toBeNull();
    expect(await embeddedPageQuarterTurn(upright, 1)).toBe(0);
  });

  it("parses Schedule 6 and Schedule 23 as separate meter rows on a sideways scan", () => {
    const text = readFileSync(new URL("./fixtures/rmp-terra-aug-oct.txt", import.meta.url), "utf8");
    const rows = parseRockyMountainBills(text, "rmp-terra-sideways.pdf");
    expect(rows.map((row) => `${row.billing_period_start}|${row.meter_id}`)).toEqual([
      "2025-07-08|348204387",
      "2025-07-08|348204388",
      "2025-09-08|348204387",
      "2025-09-08|348204388",
    ]);

    const augPortable = rows[0];
    const augSchool = rows[1];
    expect(augPortable?.billing_period_end).toBe("2025-08-07");
    expect(augPortable?.billing_days).toBe("30");
    expect(augPortable?.kwh_total).toBe("1040");
    expect(augPortable?.demand_kw_max).toBe("4");
    expect(augPortable?.rate_schedule).toBe("23");
    expect(augPortable?.amount_due_usd).toBe("162.71");
    expect(augPortable?.total_new_charges_usd).toBe("162.71");
    expect(augPortable?.notes).toContain("this item's lines");
    expect(augSchool?.kwh_total).toBe("27760");
    expect(augSchool?.demand_kw_max).toBe("81");
    expect(augSchool?.rate_schedule).toBe("6");
    expect(augSchool?.billing_period_end).toBe("2025-08-07");
    expect(augSchool?.amount_due_usd).toBe("4045.85");
    expect(augSchool?.notes).toContain("account new charges minus");
    expect(Number(augPortable?.amount_due_usd) + Number(augSchool?.amount_due_usd)).toBeCloseTo(4208.56, 2);
    expect(augSchool?.amount_due_usd).not.toBe("4208.56");

    const octPortable = rows[2];
    const octSchool = rows[3];
    expect(octPortable?.billing_period_end).toBe("2025-10-07");
    expect(octPortable?.billing_days).toBe("29");
    expect(octPortable?.kwh_total).toBe("720");
    expect(octPortable?.demand_kw_max).toBe("19");
    expect(octPortable?.rate_schedule).toBe("23");
    expect(octPortable?.amount_due_usd).toBe("99.34");
    expect(octSchool?.kwh_total).toBe("31920");
    expect(octSchool?.demand_kw_max).toBe("120");
    expect(octSchool?.rate_schedule).toBe("6");
    expect(octSchool?.amount_due_usd).toBe("5202.45");
    expect(Number(octPortable?.amount_due_usd) + Number(octSchool?.amount_due_usd)).toBeCloseTo(5301.79, 2);

    for (const row of rows) {
      expect(row?.customer_name).toBe("TERRA ACADEMY");
      expect(row?.customer_account).toBe("41652777-0018");
      expect(row?.service_address).toBe("267 S AGGIE BLVD");
      expect(row?.service_city).toBe("VERNAL");
      expect(row?.service_state).toBe("UT");
      expect(row?.service_zip).toBe("84078-7603");
      expect(row?.parser_id).toBe(RMP_PARSER_ID);
      expect(row?.kwh_on_peak).toBe("");
      expect(row?.kwh_mid_peak).toBe("");
      expect(row?.kwh_off_peak).toBe("");
      expect(row?.kwh_super_off_peak).toBe("");
      expect(row?.amount_due_usd).toBe(row?.total_new_charges_usd);
    }
    expect(augPortable?.bill_prepared_date).toBe("2025-08-08");
    expect(augPortable?.due_date).toBe("2025-09-02");
    expect(octSchool?.bill_prepared_date).toBe("2025-10-08");
    expect(octSchool?.due_date).toBe("2025-10-30");
    const items = JSON.parse(augPortable?.line_items_json ?? "[]") as { label: string; amount_usd: string }[];
    expect(items.some((item) => item.label.startsWith("Energy Charge") && item.amount_usd === "126.30")).toBe(true);

    const outcome = parseDocument(text, "rmp-terra-sideways.pdf");
    expect(outcome.rows).toHaveLength(4);
    expect(outcome.rows.every((row) => row.status === "ok")).toBe(true);
  });

  it("OCRs the sideways multi-item scan into one row per meter and period", async () => {
    const bytes = new Uint8Array(readFileSync(new URL("./fixtures/rmp-terra-sideways.pdf", import.meta.url)));
    const text = await extractPdfText(bytes);
    const outcome = parseDocument(text, "rmp-terra-sideways.pdf");
    const rows = outcome.rows;
    expect(rows.length).toBeGreaterThanOrEqual(16);
    expect(rows.length).toBeLessThanOrEqual(24);
    const meters = new Set(rows.map((row) => row.fields.meter_id));
    expect(meters.has("348204387")).toBe(true);
    expect(meters.has("348204388")).toBe(true);
    expect([...meters].every((meter) => meter === "348204387" || meter === "348204388")).toBe(true);

    const august = rows.filter((row) => row.fields.billing_period_start === "2025-07-08");
    expect(august.map((row) => row.fields.meter_id).sort()).toEqual(["348204387", "348204388"]);
    const portable = august.find((row) => row.fields.meter_id === "348204387");
    const school = august.find((row) => row.fields.meter_id === "348204388");
    expect(portable?.status).toBe("ok");
    expect(portable?.fields.billing_period_end).toBe("2025-08-07");
    expect(portable?.fields.kwh_total).toBe("1040");
    expect(portable?.fields.demand_kw_max).toBe("4");
    expect(portable?.fields.rate_schedule).toBe("23");
    expect(portable?.fields.customer_account).toBe("41652777-0018");
    expect(school?.status).toBe("ok");
    expect(school?.fields.billing_period_end).toBe("2025-08-07");
    expect(school?.fields.kwh_total).toBe("27760");
    expect(school?.fields.demand_kw_max).toBe("81");
    expect(school?.fields.rate_schedule).toBe("6");
    expect(school?.fields.kwh_on_peak).toBe("");
    expect(school?.fields.amount_due_usd).not.toBe(portable?.fields.amount_due_usd);
    expect(Number(school?.fields.amount_due_usd)).toBeGreaterThan(Number(portable?.fields.amount_due_usd));
    const keys = rows.map((row) => `${row.fields.meter_id}|${row.fields.billing_period_start}|${row.fields.billing_period_end}`);
    expect(new Set(keys).size).toBe(keys.length);
  }, 240_000);

  it("parses Schedule 6A on-peak and off-peak lines as one row per meter", () => {
    const text = readFileSync(new URL("./fixtures/rmp-ifly-6a-unpdf.txt", import.meta.url), "utf8");
    const expected = readFileSync(new URL("./fixtures/rmp-ifly-6a-expected.tsv", import.meta.url), "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.split("\t"));
    const rows = parseRockyMountainBills(text, "rmp-ifly-6a.txt");
    expect(rows).toHaveLength(expected.length);
    expect(expected).toHaveLength(24);

    for (const [index, cols] of expected.entries()) {
      const row = rows[index];
      const start = longToIso(cols[3] ?? "");
      expect(row?.meter_id, start).toBe(cols[0]);
      expect(row?.rate_schedule, start).toBe(cols[2]);
      expect(row?.billing_period_start, start).toBe(start);
      expect(row?.billing_period_end, start).toBe(longToIso(cols[4] ?? ""));
      expect(row?.billing_days, start).toBe(cols[5]);
      expect(row?.kwh_on_peak, start).toBe(cols[7]);
      expect(row?.kwh_off_peak, start).toBe(cols[8]);
      expect(row?.kwh_total, start).toBe(cols[9]);
      expect(row?.demand_kw_on_peak, start).toBe(cols[10]);
      expect(row?.demand_kw_off_peak, start).toBe(cols[11]);
      expect(row?.demand_kw_max, start).toBe(cols[12]);
      expect(row?.total_new_charges_usd, start).toBe(cols[13]);
      expect(row?.amount_due_usd, start).toBe(cols[13]);
      expect(row?.bill_prepared_date, start).toBe(cols[14]);
      expect(row?.due_date, start).toBe(cols[15]);
      expect(row?.utility).toBe("Rocky Mountain Power");
      expect(row?.customer_name).toBe("TOTAL FITNESS CENTER");
      expect(row?.customer_account).toBe("90000001-0011");
      expect(row?.kwh_mid_peak).toBe("");
      expect(row?.kwh_super_off_peak).toBe("");
      expect(row?.notes).toContain("time-of-day");
      expect(row?.notes).not.toContain("non-TOU");
      expect(Number(row?.kwh_on_peak) + Number(row?.kwh_off_peak)).toBe(Number(row?.kwh_total));
      expect(row?.demand_kw_max).toBe(String(Math.max(Number(row?.demand_kw_on_peak), Number(row?.demand_kw_off_peak))));
      if (cols[0] === "348223920") {
        expect(row?.service_address).toBe("338 23RD ST");
      } else {
        expect(row?.service_address).toBe("2261 KIESEL AVE STE 210");
      }
      expect(row?.service_city).toBe("OGDEN");
    }

    const october = rows.filter((row) => row.bill_prepared_date === "2025-10-27");
    expect(october).toHaveLength(2);
    expect(october.map((row) => row.billing_period_start)).toEqual(["2025-09-24", "2025-09-24"]);
    expect(october[0]?.notes).toContain("statement also bills 09/25 charges 9,040.17 with no meter reads");
    expect(october[1]?.notes).toContain("statement also bills 09/25 charges 17,055.05 with no meter reads");
    expect(rows.filter((row) => row.notes.includes("09/25"))).toHaveLength(2);
    expect(rows.some((row) => row.billing_period_end.startsWith("2025-09"))).toBe(false);

    const statementTotals = new Map<string, number>();
    for (const match of text.matchAll(/New Charges\s+\+([\d,]+\.\d{2})/g)) {
      const prior = text.slice(0, match.index ?? 0);
      const billed = [...prior.matchAll(/BILLING DATE:\s*([A-Za-z]+ \d{1,2}, \d{4})/g)].at(-1)?.[1] ?? "";
      statementTotals.set(longToIso(billed), chargeCents((match[1] ?? "").replaceAll(",", "")));
    }
    const byBill = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byBill.get(row.bill_prepared_date) ?? [];
      list.push(row);
      byBill.set(row.bill_prepared_date, list);
    }
    expect([...byBill.keys()].sort()).toEqual([...statementTotals.keys()].sort());
    for (const [billed, group] of byBill) {
      const itemCents = group.reduce((total, row) => total + chargeCents(row.total_new_charges_usd), 0);
      const extraCents = group.reduce((total, row) => {
        const extras = [...row.notes.matchAll(/statement also bills \d{2}\/\d{2} charges ([\d,]+\.\d{2})/g)];
        return total + extras.reduce((sum, extra) => sum + chargeCents((extra[1] ?? "").replaceAll(",", "")), 0);
      }, 0);
      expect(itemCents + extraCents, billed).toBe(statementTotals.get(billed));
    }

    const january = rows.filter((row) => row.bill_prepared_date === "2026-01-28");
    expect(january.reduce((total, row) => total + chargeCents(row.total_new_charges_usd), 0)).toBe(chargeCents("26514.74"));

    const outcome = parseDocument(text, "rmp-ifly-6a.txt");
    expect(outcome.rows).toHaveLength(24);
    expect(outcome.rows.every((row) => row.status === "ok")).toBe(true);
    expect(outcome.rows.map((row) => row.fields.customer_account)).toEqual(Array.from({ length: 24 }, () => "90000001-0011"));
  });

  it("splits Schedule 6A energy, fees, and taxes for every iFly meter period", () => {
    const text = readFileSync(new URL("./fixtures/rmp-ifly-6a-unpdf.txt", import.meta.url), "utf8");
    const rows = parseRockyMountainBills(text, "rmp-ifly-6a.txt");
    const expected = expectedCharges();
    expect(expected).toHaveLength(24);
    expect(rows).toHaveLength(24);

    for (const period of expected) {
      const row = rows.find(
        (item) =>
          item.meter_id === period.meter &&
          item.billing_period_start === period.start &&
          item.billing_period_end === period.end,
      );
      const id = `${period.meter} ${period.start}`;
      expect(row, id).toBeDefined();
      expect(row?.energy_charges_usd, id).toBe(period.energy);
      expect(row?.demand_charges_usd, id).toBe(period.demand);
      expect(row?.fees_usd, id).toBe(period.fees);
      expect(row?.taxes_usd, id).toBe(period.taxes);
      expect(row?.total_new_charges_usd, id).toBe(period.total);
      expect(row?.other_charges_usd, id).toBe("0.00");
      const parts = [period.energy, period.demand, period.fees, period.taxes].reduce(
        (total, amount) => total + chargeCents(amount),
        0,
      );
      expect(parts, id).toBe(chargeCents(period.total));
    }

    const outcome = parseDocument(text, "rmp-ifly-6a.txt");
    expect(outcome.rows).toHaveLength(24);
    expect(outcome.rows.every((row) => row.status === "ok")).toBe(true);
  });

  it("categorizes the first iFly period line by line", () => {
    const text = readFileSync(new URL("./fixtures/rmp-ifly-6a-unpdf.txt", import.meta.url), "utf8");
    const rows = parseRockyMountainBills(text, "rmp-ifly-6a.txt");
    const flow = rows.find(
      (row) => row.meter_id === "348223920" && row.billing_period_start === "2025-07-25" && row.billing_period_end === "2025-08-25",
    );
    const fly = rows.find(
      (row) => row.meter_id === "77248816" && row.billing_period_start === "2025-07-25" && row.billing_period_end === "2025-08-25",
    );
    const flowItems = lineItems(flow);
    const flyItems = lineItems(fly);

    expectLine(flowItems, "3634.76", "energy", /First/i);
    expectLine(flowItems, "5859.26", "energy", /Additional/i);
    expectLine(flowItems, "-2033.85", "energy", /Off-peak/i);
    expectLine(flowItems, "54.00", "fee", /Basic Charge/i);
    expectLine(flowItems, "-36.55", "fee", /Renewable Energy/i);
    expectLine(flowItems, "2035.88", "fee", /Energy Balancing/i);
    expectLine(flowItems, "18.03", "fee", /Wildfire/i);
    expectLine(flowItems, "350.00", "fee", /Customer Efficiency/i);
    expectLine(flowItems, "26.49", "fee", /Elec Vehicle/i);
    expectLine(flowItems, "5.60", "fee", /Lifeline/i);
    expectLine(flowItems, "594.48", "tax", /Municipal Energy/i);
    expectLine(flowItems, "718.33", "tax", /Utah Sales Tax/i);
    expect(flowItems.some((item) => item.category === "demand")).toBe(false);

    expectLine(flyItems, "9687.86", "energy", /First/i);
    expectLine(flyItems, "1002.17", "energy", /Additional/i);
    expectLine(flyItems, "-1517.67", "energy", /Off-peak/i);
    expectLine(flyItems, "54.00", "fee", /Basic Charge/i);
    expectLine(flyItems, "-44.94", "fee", /Renewable Energy/i);
    expectLine(flyItems, "2503.14", "fee", /Energy Balancing/i);
    expectLine(flyItems, "22.14", "fee", /Wildfire/i);
    expectLine(flyItems, "430.33", "fee", /Customer Efficiency/i);
    expectLine(flyItems, "32.57", "fee", /Elec Vehicle/i);
    expectLine(flyItems, "5.60", "fee", /Lifeline/i);
    expectLine(flyItems, "730.18", "tax", /Municipal Energy/i);
    expectLine(flyItems, "882.30", "tax", /Utah Sales Tax/i);
    expect(flyItems.some((item) => item.category === "demand")).toBe(false);
  });

  it("inherits the charge heading on prorated for-N-days lines", () => {
    const text = readFileSync(new URL("./fixtures/rmp-ifly-6a-unpdf.txt", import.meta.url), "utf8");
    const rows = parseRockyMountainBills(text, "rmp-ifly-6a.txt");
    const byPeriod = (meter: string, start: string) =>
      lineItems(rows.find((row) => row.meter_id === meter && row.billing_period_start === start));

    const october = byPeriod("348223920", "2025-09-24");
    for (const amount of ["755.01", "2561.26", "868.88", "2947.54", "-347.69", "-1179.55"]) {
      expectLine(october, amount, "energy", /^for \d+ day\(s\)/i);
    }

    const june = byPeriod("348223920", "2026-05-26");
    expectLine(june, "3568.10", "energy", /^for 24 day\(s\)/i);
    expectLine(june, "657.83", "energy", /^for 5 day\(s\)/i);
    expectLine(june, "-29.33", "fee", /^for 24 day\(s\)/i);
    expectLine(june, "-5.35", "fee", /^for 5 day\(s\)/i);

    const august = byPeriod("348223920", "2026-07-27");
    expectLine(august, "31.45", "fee", /^for 16 day\(s\)/i);
    expectLine(august, "24.21", "fee", /^for 13 day\(s\)/i);
    expectLine(august, "31.23", "fee", /Schedule 92/i);

    const january = byPeriod("77248816", "2025-12-26");
    expectLine(january, "18.09", "fee", /^for 27 day\(s\)/i);
    expectLine(january, "6.25", "fee", /^for 5 day\(s\)/i);
  });

  it("keeps prorated energy and demand off fees on other Rocky Mountain schedules", async () => {
    const rows = parseRockyMountainBills(layout, "rmp-combined.pdf");
    const at = (start: string) => rows.find((row) => row.billing_period_start === start);

    const april = at("2025-04-16");
    expect(april?.energy_charges_usd).toBe("165.18");
    expect(april?.demand_charges_usd).toBe("0.00");
    expect(april?.fees_usd).toBe("97.27");
    expect(april?.taxes_usd).toBe("34.73");
    expect(april?.other_charges_usd).toBe("19.72");

    const may = at("2025-05-15");
    expect(may?.energy_charges_usd).toBe("177.50");
    expect(may?.demand_charges_usd).toBe("0.00");
    expect(may?.fees_usd).toBe("102.61");
    expect(may?.taxes_usd).toBe("36.79");
    expect(may?.other_charges_usd).toBe("0.00");

    const september = at("2025-09-16");
    expect(september?.energy_charges_usd).toBe("463.14");
    expect(september?.demand_charges_usd).toBe("51.85");
    expect(september?.fees_usd).toBe("202.15");
    expect(september?.taxes_usd).toBe("96.39");
    expect(september?.other_charges_usd).toBe("-2.63");

    const latest = at("2026-02-17");
    expect(latest?.energy_charges_usd).toBe("680.41");
    expect(latest?.demand_charges_usd).toBe("97.56");
    expect(latest?.fees_usd).toBe("290.82");
    expect(latest?.taxes_usd).toBe("141.71");

    const june = lineItems(at("2025-06-16"));
    expectLine(june, "36.01", "fee", /^for 16 day\(s\)/i);
    expectLine(june, "28.30", "fee", /^for 14 day\(s\)/i);

    const terra = parseRockyMountainBills(
      readFileSync(new URL("./fixtures/rmp-terra-aug-oct.txt", import.meta.url), "utf8"),
      "rmp-terra-sideways.pdf",
    );
    const august = terra.find((row) => row.meter_id === "348204387" && row.billing_period_start === "2025-07-08");
    expect(august?.energy_charges_usd).toBe("126.30");
    expect(august?.fees_usd).toBe("36.41");
    const october = terra.find((row) => row.meter_id === "348204387" && row.billing_period_start === "2025-09-08");
    expect(october?.demand_charges_usd).toBe("89.34");
    expect(october?.fees_usd).toBe("10.00");
    expect(october?.energy_charges_usd).toBe("0.00");

    const bytes = new Uint8Array(readFileSync(new URL("./fixtures/rmp-combined.pdf", import.meta.url)));
    const unlocked = parseRockyMountainBills(await extractPdfText(bytes, PASSWORD), "rmp-combined.pdf");
    for (const [start, energy, demand, fees] of [
      ["2025-04-16", "165.18", "0.00", "97.27"],
      ["2025-05-15", "177.50", "0.00", "102.61"],
      ["2025-09-16", "463.14", "51.85", "202.15"],
    ] as const) {
      const row = unlocked.find((item) => item.billing_period_start === start);
      expect(row?.energy_charges_usd, start).toBe(energy);
      expect(row?.demand_charges_usd, start).toBe(demand);
      expect(row?.fees_usd, start).toBe(fees);
      expect(row?.other_charges_usd, start).toBe("0.00");
    }
  });
});
