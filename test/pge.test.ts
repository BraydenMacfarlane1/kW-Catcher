import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDocument, parsers } from "../src/parsers/registry";
import { __pgeInternals, pgeParser } from "../src/parsers/pge";

// Redacted OCR text of a 20-page scanned PG&E B-10 (secondary) bill with Ava Community Energy
// generation: 10 statements (PG&E delivery page + Ava page each). IDs are fake (9000000000-0 etc).
const text = readFileSync(new URL("./fixtures/pge-b10s-ava-ocr.txt", import.meta.url), "utf8");
const [head, ...lines] = readFileSync(new URL("./fixtures/pge-b10s-ava-expected.tsv", import.meta.url), "utf8").trim().split("\n");
const cols = head!.split("\t");
const expected = lines.map((line) => Object.fromEntries(cols.map((c, i) => [c, line.split("\t")[i] ?? ""])));

describe("PG&E B10S + CCA (scanned, OCR)", () => {
  const outcome = parseDocument(text, "bill.pdf");
  const rows = outcome.rows;

  it("is routed to the PG&E parser only", () => {
    expect(parsers().filter((p) => p.match(text)).map((p) => p.id)).toEqual([pgeParser.id]);
    expect(rows.every((r) => r.fields.parser_id === pgeParser.id)).toBe(true);
  });

  it("emits one combined row per statement period", () => {
    expect(rows.map((r) => r.fields.billing_period_start).sort()).toEqual(expected.map((e) => e.billing_period_start).sort());
  });

  it("every ok row matches the hand-read bill exactly; the rest are flagged, never wrong", () => {
    let ok = 0;
    for (const e of expected) {
      const row = rows.find((r) => r.fields.billing_period_start === e.billing_period_start)!;
      const f = row.fields as unknown as Record<string, string>;
      if (row.status === "ok") {
        ok += 1;
        for (const c of cols) if (c in f) expect([e.billing_period_start, c, f[c]]).toEqual([e.billing_period_start, c, e[c]]);
      } else {
        expect(row.status).toBe("failed");
        expect(f.notes).toMatch(/^needs_review/);
        // identity and dates still come through for review
        expect(f.customer_account).toBe(e.customer_account);
        expect(f.billing_period_end).toBe(e.billing_period_end);
      }
    }
    // OCR of this scan is noisy; 4 of 10 statements reconcile with the local tesseract.js path.
    expect(ok).toBeGreaterThanOrEqual(4);
  });

  it("ok rows carry the delivery / generation split and provider-tagged line items", () => {
    const row = rows.find((r) => r.fields.billing_period_start === "2026-08-19")!;
    expect(row.status).toBe("ok");
    expect(row.fields.notes).toContain("delivery 1404.29 + generation 392.72");
    expect(row.fields.notes).toContain("Ava Community Energy B10S-Bright Choice");
    expect(row.fields.amount_due_usd).toBe("1797.01");
  });
});

describe("PG&E reconciliation helpers", () => {
  it("flatRate accepts per-kWh charges at a 5-decimal rate only", () => {
    // 4,671.1852 kWh x $0.00061 = $2.85; x $0.03780 = $176.57
    expect(__pgeInternals.flatRate(4671185200, 285)).toBe(true);
    expect(__pgeInternals.flatRate(4671185200, 17657)).toBe(true);
    expect(__pgeInternals.flatRate(4671185200, 487)).toBe(false);
  });
});
