import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ChargeLine } from "../src/parsers/charges";
import { loganCityParser, parseLoganCityBills } from "../src/parsers/logan";
import { nvEnergyParser } from "../src/parsers/nvenergy";
import { parseDocument } from "../src/parsers/registry";
import { rockyMountainParser } from "../src/parsers/rmp";
import { sceParser } from "../src/parsers/sce";

const ocr = readFileSync(new URL("./fixtures/logan-city-2026-08-ocr.txt", import.meta.url), "utf8");
const tesseract = readFileSync(new URL("./fixtures/logan-city-2026-08-tesseract.txt", import.meta.url), "utf8");
const sourceFile = "logan-city-2026-08.pdf";

function cents(value: string): number {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

function linesOf(json: string): ChargeLine[] {
  return JSON.parse(json) as ChargeLine[];
}

function expectGroundTruth(text: string): void {
  expect(loganCityParser.match(text)).toBe(true);
  expect(sceParser.match(text)).toBe(false);
  expect(nvEnergyParser.match(text)).toBe(false);
  expect(rockyMountainParser.match(text)).toBe(false);

  const outcome = parseDocument(text, sourceFile);
  expect(outcome.rows).toHaveLength(1);
  const parsed = outcome.rows[0];
  expect(parsed?.status).toBe("ok");
  const row = parsed?.fields ?? parseLoganCityBills(text, sourceFile)[0];
  expect(row?.utility).toBe("Logan City Light & Power");
  expect(row?.parser_id).toBe("logan-city-lp");
  expect(row?.parse_confidence).toBe("1.00");
  expect(row?.notes).toBe("");
  expect(row?.customer_name).toBe("BEAR RIVER ASSOC OF GOVT");
  expect(row?.customer_account).toBe("002060-001");
  expect(row?.service_address).toBe("170 N MAIN ST");
  expect(row?.service_city).toBe("LOGAN");
  expect(row?.service_state).toBe("UT");
  expect(row?.service_zip).toBe("84321-4567");
  expect(row?.rate_schedule).toBe("");
  expect(row?.meter_id).toBe("24752");
  expect(row?.billing_period_start).toBe("2026-07-15");
  expect(row?.billing_period_end).toBe("2026-08-14");
  expect(row?.billing_days).toBe("30");
  expect(row?.bill_prepared_date).toBe("2026-08-19");
  expect(row?.due_date).toBe("2026-09-08");
  expect(row?.kwh_total).toBe("10240");
  expect(row?.demand_kw_max).toBe("42");
  expect(row?.energy_charges_usd).toBe("");
  expect(row?.demand_charges_usd).toBe("");
  expect(row?.energy_demand_combined_usd).toBe("1340.80");
  expect(row?.taxes_usd).toBe("0.00");
  expect(row?.fees_usd).toBe("23.85");
  expect(row?.other_charges_usd).toBe("0.00");
  expect(row?.electric_total_usd).toBe("1364.65");
  expect(row?.non_electric_charges_usd).toBe("137.39");
  expect(row?.charges_tax_inclusive).toBe("true");
  expect(row?.embedded_tax_rate).toBe("0.06");
  expect(row?.total_new_charges_usd).toBe("1502.04");
  expect(row?.amount_due_usd).toBe("1502.04");
  expect(row?.total_new_charges_usd).not.toBe("1342.02");

  const electricCents =
    cents(row?.energy_charges_usd ?? "") +
    cents(row?.demand_charges_usd ?? "") +
    cents(row?.energy_demand_combined_usd ?? "") +
    cents(row?.taxes_usd ?? "") +
    cents(row?.fees_usd ?? "") +
    cents(row?.other_charges_usd ?? "");
  expect(electricCents).toBe(cents(row?.electric_total_usd ?? ""));
  expect(cents(row?.electric_total_usd ?? "") + cents(row?.non_electric_charges_usd ?? "")).toBe(
    cents(row?.total_new_charges_usd ?? ""),
  );

  const items = linesOf(row?.line_items_json ?? "[]");
  expect(items.map((item) => item.label)).toEqual([
    "911 Dispatch",
    "Electric Commercial Flat 3 Phase",
    "Electric Commercial Usage",
    "GB Comm City 90 Gal 1 Pickup/Wk",
    "Recycle 90 Gal Logan Pkup Biwkly",
    "Sewer Collection Commercial Flat",
    "Sewer Commercial Usage",
    "Sewer Treatment Commercial Flat",
    "Storm Water Commercial",
    'Water Commercial Flat <1"',
    "Water Commercial Usage",
  ]);
  expect(items.some((item) => item.label === "Balance at Billing")).toBe(false);

  const flat = items[1];
  expect(flat).toMatchObject({
    amount_usd: "23.85",
    service: "electric",
    category: "fee",
    tax_inclusive: true,
    embedded_tax_rate: "0.06",
  });
  expect(flat?.service_type).toBeUndefined();

  const usage = items[2];
  expect(usage).toMatchObject({
    amount_usd: "1340.80",
    service: "electric",
    category: "energy_demand",
    tax_inclusive: true,
    embedded_tax_rate: "0.06",
  });
  expect(usage?.service_type).toBeUndefined();

  const nonElectric = [
    ["911 Dispatch", "3.40", "dispatch"],
    ["GB Comm City 90 Gal 1 Pickup/Wk", "19.24", "garbage"],
    ["Recycle 90 Gal Logan Pkup Biwkly", "3.18", "recycle"],
    ["Sewer Collection Commercial Flat", "14.46", "sewer"],
    ["Sewer Commercial Usage", "18.02", "sewer"],
    ["Sewer Treatment Commercial Flat", "24.22", "sewer"],
    ["Storm Water Commercial", "11.88", "storm"],
    ['Water Commercial Flat <1"', "30.21", "water"],
    ["Water Commercial Usage", "12.78", "water"],
  ] as const;
  for (const [label, amount, serviceType] of nonElectric) {
    const item = items.find((line) => line.label === label);
    expect(item, label).toMatchObject({
      amount_usd: amount,
      service: "non_electric",
      service_type: serviceType,
      category: "other",
      tax_inclusive: false,
      embedded_tax_rate: null,
    });
  }

  const electricLines = items.filter((item) => item.service === "electric").reduce((total, item) => total + cents(item.amount_usd), 0);
  const allLines = items.reduce((total, item) => total + cents(item.amount_usd), 0);
  expect(electricLines).toBe(136465);
  expect(allLines).toBe(150204);
}

describe("Logan City Light & Power", () => {
  it("keeps the live OCR fixture complete", () => {
    expect(ocr.trim()).toHaveLength(1793);
  });

  it("does not match RMP, SCE, or NV Energy fixtures", () => {
    const sce = readFileSync(new URL("./fixtures/bill0-unpdf.txt", import.meta.url), "utf8");
    const nv = readFileSync(new URL("./fixtures/nv-energy-page1.txt", import.meta.url), "utf8");
    const rmp = readFileSync(new URL("./fixtures/rmp-bill1.txt", import.meta.url), "utf8");
    expect(loganCityParser.match(sce)).toBe(false);
    expect(loganCityParser.match(nv)).toBe(false);
    expect(loganCityParser.match(rmp)).toBe(false);
    expect(loganCityParser.match("Recreational fires are still allowed in Logan City limits.")).toBe(false);
    expect(loganCityParser.match("Rocky Mountain Power\nLogan, Utah\n")).toBe(false);
  });

  it("parses the live OCR text, both checksums, and the missing water decimal", () => {
    expect(ocr).toContain("3021");
    expect(ocr).not.toContain("30.21");
    expectGroundTruth(ocr);
    const water = linesOf(parseLoganCityBills(ocr, sourceFile)[0]?.line_items_json ?? "[]").find((item) =>
      item.label.startsWith("Water Commercial Flat"),
    );
    expect(water?.amount_usd).toBe("30.21");
  });

  it("parses the local tesseract variant to the same bill", () => {
    expect(tesseract).toContain("30.21");
    expectGroundTruth(tesseract);
  });

  it("keeps parsed fields and flags needs_review when a checksum fails", () => {
    const broken = ocr.replace("23.85", "23.86");
    const outcome = parseDocument(broken, sourceFile);
    expect(outcome.rows).toHaveLength(1);
    const row = outcome.rows[0];
    expect(row?.status).toBe("failed");
    expect(row?.fields.notes).toBe(
      "needs_review: bill total checksum failed: lines 1502.05 != 1502.04; electric total checksum failed: electric lines 1364.66 != 1364.65",
    );
    expect(row?.fields.notes.startsWith("needs_review: ")).toBe(true);
    expect(row?.fields.customer_account).toBe("002060-001");
    expect(row?.fields.customer_name).toBe("BEAR RIVER ASSOC OF GOVT");
    expect(row?.fields.meter_id).toBe("24752");
    expect(row?.fields.kwh_total).toBe("10240");
    expect(row?.fields.demand_kw_max).toBe("42");
    expect(row?.fields.amount_due_usd).toBe("1502.04");
    expect(row?.fields.total_new_charges_usd).toBe("1502.04");
    expect(row?.fields.electric_total_usd).toBe("1364.66");
    expect(row?.fields.fees_usd).toBe("23.86");
    expect(row?.fields.energy_demand_combined_usd).toBe("1340.80");
    expect(row?.fields.non_electric_charges_usd).toBe("137.39");
    expect(row?.fields.parse_confidence).toBe("0.50");
    const items = linesOf(row?.fields.line_items_json ?? "[]");
    expect(items.find((item) => item.category === "fee")?.amount_usd).toBe("23.86");
    expect(items.find((item) => item.label.startsWith("Water Commercial Flat"))?.amount_usd).toBe("30.21");
  });
});
