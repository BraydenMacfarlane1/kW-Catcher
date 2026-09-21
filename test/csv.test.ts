import { describe, expect, it } from "vitest";
import { parseCsv, toCsv } from "../src/csv";

describe("csv", () => {
  it("round-trips quotes and commas", () => {
    const csv = toCsv(["utility", "customer_name", "notes"], [
      { utility: "SCE", customer_name: "XU HOLDINGS, LLC", notes: 'said "hi"' },
    ]);
    expect(parseCsv(csv)).toEqual([
      { utility: "SCE", customer_name: "XU HOLDINGS, LLC", notes: 'said "hi"' },
    ]);
  });
});
