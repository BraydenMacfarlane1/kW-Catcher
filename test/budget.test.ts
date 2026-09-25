import { describe, expect, it } from "vitest";
import { CpuBudgetError, OCR_CPU_BUDGET_MS, OcrCpuClock } from "../src/budget";
import { renderBanner } from "../src/pages";

describe("OCR CPU budget", () => {
  it("allows another page until the budget is spent", () => {
    const clock = new OcrCpuClock();
    clock.add(OCR_CPU_BUDGET_MS - 1);
    expect(() => clock.assert()).not.toThrow();
    clock.add(1);
    expect(() => clock.assert()).toThrow(CpuBudgetError);
  });

  it("explains a stopped upload on the site page", () => {
    expect(renderBanner("cpu_budget", {})).toContain("too much CPU time");
  });
});
