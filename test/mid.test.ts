import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { BillDraft } from "../src/parsers/base";
import type { ChargeLine } from "../src/parsers/charges";
import { fplGsd1Parser } from "../src/parsers/fpl";
import { loganCityParser } from "../src/parsers/logan";
import { MID_PARSER_ID, midParser } from "../src/parsers/mid";
import { nvEnergyParser } from "../src/parsers/nvenergy";
import { parseDocument } from "../src/parsers/registry";
import { rockyMountainParser } from "../src/parsers/rmp";
import { sceParser } from "../src/parsers/sce";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

function tsv(name: string): Record<string, string>[] {
  const [head = "", ...lines] = fixture(name).trim().split("\n");
  const columns = head.split("\t");
  return lines.map((line) => {
    const cells = line.split("\t");
    return Object.fromEntries(columns.map((column, index) => [column, cells[index] ?? ""]));
  });
}

function cents(value: string): number {
  return value ? Math.round(Number(value) * 100) : 0;
}

function linesOf(row: BillDraft): ChargeLine[] {
  return JSON.parse(row.line_items_json) as ChargeLine[];
}

const UNPDF = "mid-2025-2026-unpdf.txt";
const LAYOUT = "mid-2026-05-layout.txt";
const EXPECTED = tsv("mid-expected.tsv");
const STATEMENTS = tsv("mid-expected-statements.tsv");

function key(row: Record<string, string>): string {
  return `${row.billing_period_start}|${row.service_account}`;
}

function expectMatchesTsv(row: BillDraft, expected: Record<string, string>): void {
  for (const [column, value] of Object.entries(expected)) {
    expect({ column, value: row[column as keyof BillDraft] }).toEqual({ column, value });
  }
}

describe("Modesto Irrigation District", () => {
  it("matches MID statements and no other utility", () => {
    const mid = fixture(UNPDF);
    expect(midParser.match(mid)).toBe(true);
    expect(midParser.match(fixture(LAYOUT))).toBe(true);
    for (const other of ["bill0-unpdf.txt", "nv-energy-page1.txt", "rmp-bill1.txt", "logan-city-2026-08-ocr.txt", "fpl-gsd1-2026-06.txt"]) {
      expect(midParser.match(fixture(other))).toBe(false);
    }
    for (const parser of [sceParser, nvEnergyParser, rockyMountainParser, loganCityParser, fplGsd1Parser]) {
      expect(parser.match(mid)).toBe(false);
    }
  });

  it("parses one ok row per metered SA per period from the unpdf text of the 12-statement PDF", () => {
    const outcome = parseDocument(fixture(UNPDF), "mid.pdf");
    // 12 statements in the file; 01/21/26 is printed twice, so 11 periods x 3 metered SAs.
    expect(outcome.rows).toHaveLength(EXPECTED.length);
    expect(outcome.rows.map((row) => row.status)).toEqual(EXPECTED.map(() => "ok"));
    const byKey = new Map(outcome.rows.map((row) => [key(row.fields), row.fields]));
    expect(byKey.size).toBe(EXPECTED.length);
    for (const expected of EXPECTED) {
      const row = byKey.get(key(expected));
      expect(row, key(expected)).toBeDefined();
      if (!row) continue;
      expectMatchesTsv(row, expected);
      expect(row.parser_id).toBe(MID_PARSER_ID);
      expect(row.utility).toBe("Modesto Irrigation District");
      expect(row.customer_account).toBe("9000000001");
      expect(row.customer_name).toBe("MODESTO COVENANT CHURCH");
      expect(row.service_city).toBe("Modesto");
      expect(row.service_state).toBe("CA");
      expect(row.other_charges_usd).toBe("0.00");
      expect(row.amount_due_usd).toBe(row.total_new_charges_usd);
      expect(cents(row.energy_charges_usd) + cents(row.demand_charges_usd) + cents(row.fees_usd) + cents(row.taxes_usd)).toBe(
        cents(row.electric_total_usd),
      );
      expect(row.kwh_on_peak).toBe("");
    }
  });

  it("rows add up to each statement's Current Charges, with SL2 lighting carried on one row", () => {
    const rows = parseDocument(fixture(UNPDF), "mid.pdf").rows.map((row) => row.fields);
    for (const statement of STATEMENTS) {
      const period = rows.filter((row) => row.billing_period_start === statement.billing_period_start);
      expect(period).toHaveLength(3);
      const total = period.reduce((sum, row) => sum + cents(row.total_new_charges_usd), 0);
      expect(total).toBe(cents(statement.current_charges_usd ?? ""));
      const carriers = period.filter((row) => row.non_electric_charges_usd);
      expect(carriers).toHaveLength(1);
      expect(carriers[0]?.non_electric_charges_usd).toBe(statement.sl2_lighting_usd);
      const lights = linesOf(carriers[0] as BillDraft).filter((line) => line.service === "non_electric");
      expect(lights).toHaveLength(2);
      expect(lights.every((line) => line.label.startsWith("SL2 ") && line.category === "other")).toBe(true);
    }
  });

  it("keeps the printed charge lines, including the split Power Cost Adj and both seasons", () => {
    const rows = parseDocument(fixture(UNPDF), "mid.pdf").rows.map((row) => row.fields);
    const april = rows.find((row) => row.billing_period_start === "2026-03-20" && row.service_account === "9000000012");
    expect(april && linesOf(april).filter((line) => line.service !== "non_electric")).toEqual([
      { label: "Service Fee", amount_usd: "90.00", category: "fee" },
      { label: "Winter 7,164 kWh @ $0.13184", amount_usd: "944.50", category: "energy" },
      { label: "Demand 25.30 kW @ $14.31", amount_usd: "362.04", category: "demand" },
      { label: "Environmental Energy Adj 7,164 kWh @ $0.012", amount_usd: "85.97", category: "energy" },
      { label: "Capital Infra Adj 7,164 kWh @ $0.0028", amount_usd: "20.06", category: "energy" },
      { label: "Power Cost Adj 2,687 kWh @ $0.013", amount_usd: "34.93", category: "energy" },
      { label: "Power Cost Adj 4,477 kWh @ $0.00622", amount_usd: "27.85", category: "energy" },
      { label: "City Tax @ 6%", amount_usd: "93.92", category: "tax" },
      { label: "State Surcharge Total kWh @ $0.0003", amount_usd: "2.15", category: "tax" },
    ]);
    const transition = rows.find((row) => row.billing_period_start === "2025-09-19" && row.service_account === "9000000012");
    const labels = transition ? linesOf(transition).map((line) => line.label) : [];
    expect(labels).toContain("Summer 3,795 kWh @ $0.1578");
    expect(labels).toContain("Winter 4,973 kWh @ $0.13184");
    expect(transition?.kwh_total).toBe("8768");
  });

  it("parses pdftotext -layout text of one statement the same way", () => {
    const outcome = parseDocument(fixture(LAYOUT), "mid-2026-05.pdf");
    const expected = EXPECTED.filter((row) => row.billing_period_start === "2026-04-21");
    expect(outcome.rows).toHaveLength(3);
    expect(outcome.rows.map((row) => row.status)).toEqual(["ok", "ok", "ok"]);
    for (const [index, row] of outcome.rows.entries()) {
      expectMatchesTsv(row.fields, expected[index] ?? {});
    }
  });

  it("reads any number of season, block and PCA lines without assuming a count", () => {
    // No statement in the sample tops 20,000 kWh, so no over-20,000 block line was printed.
    // Split one summer line into two blocks (same dollars) and add a $0.00 PCA line.
    const layout = fixture(LAYOUT);
    const split = layout
      .replace(
        /Summer 4,286 kWh @ \$0\.1578( +)\$676\.33/,
        (_line, gap: string) =>
          `Summer 3,286 kWh @ $0.1578${gap}$518.53\n                                              Summer 1,244 kWh @ $0.12685${gap}$157.80`,
      )
      .replace(
        /Power Cost Adj 2,253 kWh @ \$0\.00622 +\$14\.01/,
        (line) => `${line}\n                                               Power Cost Adj 4,281 kWh @ $0.00000      $0.00`,
      );
    expect(split).not.toBe(layout);
    const row = parseDocument(split, "mid-2026-05.pdf").rows.find((candidate) => candidate.fields.service_account === "9000000012");
    expect(row?.fields.notes).toBe("statement current charges 2573.25");
    expect(row?.status).toBe("ok");
    expect(row?.fields.kwh_total).toBe("6778");
    expect(row?.fields.energy_charges_usd).toBe("1083.43");
    const labels = row ? linesOf(row.fields).map((line) => line.label) : [];
    expect(labels).toEqual(expect.arrayContaining(["Summer 3,286 kWh @ $0.1578", "Summer 1,244 kWh @ $0.12685", "Power Cost Adj 4,281 kWh @ $0.00000"]));
  });

  it("marks rows needs_review when an SA does not add up to its Total Charges", () => {
    const broken = fixture(LAYOUT).replace("$676.33", "$676.34");
    const outcome = parseDocument(broken, "mid-2026-05.pdf");
    const bad = outcome.rows.find((row) => row.fields.service_account === "9000000012");
    expect(bad?.status).toBe("failed");
    expect(bad?.fields.notes).toMatch(/^needs_review: SA 9000000012: lines 1553.58 != Total Charges 1553.57/);
    expect(outcome.rows.filter((row) => row.status === "ok")).toHaveLength(2);
  });

  it("marks every row of a statement needs_review when SAs do not add up to Current Charges", () => {
    const broken = fixture(LAYOUT).replace(/(Current Charges\s+)\$2,573\.25/, "$1$2,573.26");
    const outcome = parseDocument(broken, "mid-2026-05.pdf");
    expect(outcome.rows.map((row) => row.status)).toEqual(["failed", "failed", "failed"]);
    for (const row of outcome.rows) {
      expect(row.fields.notes).toMatch(/^needs_review: SA totals 2573.25 != Current Charges 2573.26/);
    }
  });

  it("marks the carrier row needs_review when an SL2 lighting SA does not add up", () => {
    const broken = fixture(LAYOUT).replace(/(Sodium Vapor 100 Watt Light 1 @ \$20\.30\s*\n\s*_+)\$20\.30/, "$1$20.31");
    const outcome = parseDocument(broken, "mid-2026-05.pdf");
    const carrier = outcome.rows.find((row) => row.fields.service_account === "9000000012");
    expect(carrier?.status).toBe("failed");
    expect(carrier?.fields.notes).toMatch(/^needs_review: SA 900000001[14]: lines 22.23 != Total Charges 22.22/);
  });
});
