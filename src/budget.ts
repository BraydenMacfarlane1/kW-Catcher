/**
 * OCR time budget for one HTTP request.
 *
 * `wrangler.jsonc` sets `limits.cpu_ms` to 300000. Crossing that limit kills
 * the isolate; user code does not run, and Cloudflare answers with a bare 503.
 * This clock stops between pages earlier than that. It counts time spent
 * decoding, rotating, and recognizing a page, and it does not count time
 * spent waiting on Workers AI.
 *
 * One page can still overrun the platform limit after the check, because
 * recognition cannot be cancelled mid-call.
 */
export const OCR_CPU_BUDGET_MS = 250_000;

export class CpuBudgetError extends Error {
  constructor() {
    super("cpu_budget");
    this.name = "CpuBudgetError";
  }
}

export class OcrCpuClock {
  private spent = 0;

  add(ms: number): void {
    if (ms > 0) this.spent += ms;
  }

  assert(): void {
    if (this.spent >= OCR_CPU_BUDGET_MS) throw new CpuBudgetError();
  }
}
