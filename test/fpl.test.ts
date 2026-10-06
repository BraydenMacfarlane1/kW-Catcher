import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ChargeLine } from "../src/parsers/charges";
import { FPL_GSD1_PARSER_ID, fplGsd1Parser } from "../src/parsers/fpl";
import { loganCityParser } from "../src/parsers/logan";
import { nvEnergyParser } from "../src/parsers/nvenergy";
import { parseDocument } from "../src/parsers/registry";
import { rockyMountainParser } from "../src/parsers/rmp";
import { sceParser } from "../src/parsers/sce";

const FIXTURES = ["fpl-gsd1-2026-06.txt", "fpl-gsd1-2026-07.txt", "fpl-gsd1-2026-08.txt"] as const;

const BILLED = {
  "2026-05-22": { amount_due_usd: "5861.54", due_date: "2026-07-14", bill_prepared_date: "2026-06-23" },
  "2026-06-23": { amount_due_usd: "4598.27", due_date: "2026-08-13", bill_prepared_date: "2026-07-23" },
  "2026-07-23": { amount_due_usd: "6682.97", due_date: "2026-09-14", bill_prepared_date: "2026-08-24" },
} as const;

function cents(value: string): number {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

function linesOf(json: string): ChargeLine[] {
  return JSON.parse(json) as ChargeLine[];
}

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

function expectedRows(): Record<string, string>[] {
  return fixture("fpl-gsd1-expected.tsv")
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const [
        billing_period_start,
        billing_period_end,
        billing_days,
        meter_id,
        kwh_total,
        demand_kw_max,
        energy_charges_usd,
        demand_charges_usd,
        fees_usd,
        taxes_usd,
        total_new_charges_usd,
        rate_schedule,
      ] = line.split("\t");
      return {
        billing_period_start: billing_period_start ?? "",
        billing_period_end: billing_period_end ?? "",
        billing_days: billing_days ?? "",
        meter_id: meter_id ?? "",
        kwh_total: kwh_total ?? "",
        demand_kw_max: demand_kw_max ?? "",
        energy_charges_usd: energy_charges_usd ?? "",
        demand_charges_usd: demand_charges_usd ?? "",
        fees_usd: fees_usd ?? "",
        taxes_usd: taxes_usd ?? "",
        total_new_charges_usd: total_new_charges_usd ?? "",
        rate_schedule: rate_schedule ?? "",
      };
    });
}

describe("Florida Power & Light GSD-1", () => {
  it("matches an FPL bill and does not match the other utilities", () => {
    const fpl = fixture("fpl-gsd1-2026-06.txt");
    const sce = fixture("bill0-unpdf.txt");
    const nv = fixture("nv-energy-page1.txt");
    const rmp = fixture("rmp-bill1.txt");
    const logan = fixture("logan-city-2026-08-ocr.txt");

    expect(fplGsd1Parser.match(fpl)).toBe(true);
    expect(fplGsd1Parser.match(sce)).toBe(false);
    expect(fplGsd1Parser.match(nv)).toBe(false);
    expect(fplGsd1Parser.match(rmp)).toBe(false);
    expect(fplGsd1Parser.match(logan)).toBe(false);

    expect(sceParser.match(fpl)).toBe(false);
    expect(nvEnergyParser.match(fpl)).toBe(false);
    expect(rockyMountainParser.match(fpl)).toBe(false);
    expect(loganCityParser.match(fpl)).toBe(false);
  });

  it("parses each redacted bill into one ok row that matches the TSV", () => {
    const expected = expectedRows();
    expect(expected).toHaveLength(FIXTURES.length);

    for (const [index, name] of FIXTURES.entries()) {
      const want = expected[index];
      expect(want, name).toBeDefined();
      const outcome = parseDocument(fixture(name), name.replace(/\.txt$/, ".pdf"));
      expect(outcome.rows, name).toHaveLength(1);
      const parsed = outcome.rows[0];
      expect(parsed?.status, name).toBe("ok");
      const row = parsed?.fields;
      expect(row?.parser_id, name).toBe(FPL_GSD1_PARSER_ID);
      expect(row?.utility, name).toBe("Florida Power & Light");
      expect(row?.customer_name, name).toBe("TEAM SUCCESS A SCHOOL OF EXCELLENCE INC");
      expect(row?.customer_account, name).toBe("90000-00001");
      expect(row?.service_address, name).toBe("202 13TH AVE E # 0481-4 BAMS");
      expect(row?.service_city, name).toBe("BRADENTON");
      expect(row?.service_state, name).toBe("FL");
      expect(row?.service_zip, name).toBe("34208");
      expect(row?.meter_id, name).toBe(want?.meter_id);
      expect(row?.rate_schedule, name).toBe(want?.rate_schedule);
      expect(row?.billing_period_start, name).toBe(want?.billing_period_start);
      expect(row?.billing_period_end, name).toBe(want?.billing_period_end);
      expect(row?.billing_days, name).toBe(want?.billing_days);
      expect(row?.kwh_total, name).toBe(want?.kwh_total);
      expect(row?.demand_kw_max, name).toBe(want?.demand_kw_max);
      expect(row?.energy_charges_usd, name).toBe(want?.energy_charges_usd);
      expect(row?.demand_charges_usd, name).toBe(want?.demand_charges_usd);
      expect(row?.fees_usd, name).toBe(want?.fees_usd);
      expect(row?.taxes_usd, name).toBe(want?.taxes_usd);
      expect(row?.total_new_charges_usd, name).toBe(want?.total_new_charges_usd);
      expect(row?.other_charges_usd, name).toBe("0.00");
      expect(row?.energy_demand_combined_usd, name).toBe("");
      expect(row?.charges_tax_inclusive, name).toBe("");
      expect(row?.notes, name).toBe("");
      expect(row?.parse_confidence, name).toBe("1.00");

      const billed = BILLED[row?.billing_period_start as keyof typeof BILLED];
      expect(row?.amount_due_usd, name).toBe(billed.amount_due_usd);
      expect(row?.due_date, name).toBe(billed.due_date);
      expect(row?.bill_prepared_date, name).toBe(billed.bill_prepared_date);

      const parts =
        cents(row?.energy_charges_usd ?? "") +
        cents(row?.demand_charges_usd ?? "") +
        cents(row?.fees_usd ?? "") +
        cents(row?.taxes_usd ?? "");
      expect(parts, name).toBe(cents(row?.total_new_charges_usd ?? ""));

      const items = linesOf(row?.line_items_json ?? "[]");
      expect(items.some((item) => /taxes and charges/i.test(item.label)), name).toBe(false);
      expect(items.some((item) => /electric service amount/i.test(item.label)), name).toBe(false);
      const itemSum = items.reduce((total, item) => total + cents(item.amount_usd), 0);
      expect(itemSum, name).toBe(cents(row?.total_new_charges_usd ?? ""));
    }
  });

  it("keeps the May–Jun charge categories by amount", () => {
    const outcome = parseDocument(fixture("fpl-gsd1-2026-06.txt"), "fpl-gsd1-2026-06.pdf");
    const items = linesOf(outcome.rows[0]?.fields.line_items_json ?? "[]");
    expect(items.map((item) => [item.category, item.amount_usd, item.label])).toEqual([
      ["fee", "33.71", "Base charge"],
      ["energy", "1727.23", "Non-fuel"],
      ["energy", "1777.20", "Fuel"],
      ["demand", "2404.80", "Demand"],
      ["fee", "-122.00", "On call credit"],
      ["tax", "149.38", "Gross receipts tax (State tax)"],
      ["fee", "87.14", "Late payment charge"],
      ["fee", "5.14", "Regulatory fee (State fee)"],
    ]);
  });
});
