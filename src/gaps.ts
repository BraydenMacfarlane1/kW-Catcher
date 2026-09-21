export interface DatedBill {
  billing_period_start: string;
  billing_period_end: string;
}

export type TimelineRow<T> =
  | { kind: "bill"; bill: T }
  | { kind: "gap"; month: string };

function monthEnd(month: string): string {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return `${month}-${String(lastDay).padStart(2, "0")}`;
}

export function monthsBetween(startIso: string, endIso: string): string[] {
  const months: string[] = [];
  let year = Number(startIso.slice(0, 4));
  let month = Number(startIso.slice(5, 7));
  const endYear = Number(endIso.slice(0, 4));
  const endMonth = Number(endIso.slice(5, 7));
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

function overlapsMonth(start: string, end: string, month: string): boolean {
  return start <= monthEnd(month) && end >= `${month}-01`;
}

export function missingMonths(bills: readonly DatedBill[]): string[] {
  const dated = bills.filter((bill) => bill.billing_period_start && bill.billing_period_end);
  if (dated.length === 0) return [];
  let minStart = dated[0]?.billing_period_start ?? "";
  let maxEnd = dated[0]?.billing_period_end ?? "";
  for (const bill of dated) {
    if (bill.billing_period_start < minStart) minStart = bill.billing_period_start;
    if (bill.billing_period_end > maxEnd) maxEnd = bill.billing_period_end;
  }
  return monthsBetween(minStart, maxEnd).filter(
    (month) => !dated.some((bill) => overlapsMonth(bill.billing_period_start, bill.billing_period_end, month)),
  );
}

export function timelineRows<T extends DatedBill>(bills: readonly T[]): TimelineRow<T>[] {
  const dated = bills.filter((bill) => bill.billing_period_start && bill.billing_period_end);
  const undated = bills.filter((bill) => !bill.billing_period_start || !bill.billing_period_end);
  if (dated.length === 0) return undated.map((bill) => ({ kind: "bill", bill }));

  let minStart = dated[0]?.billing_period_start ?? "";
  let maxEnd = dated[0]?.billing_period_end ?? "";
  for (const bill of dated) {
    if (bill.billing_period_start < minStart) minStart = bill.billing_period_start;
    if (bill.billing_period_end > maxEnd) maxEnd = bill.billing_period_end;
  }
  const missing = new Set(missingMonths(dated));
  const byStartMonth = new Map<string, T[]>();
  for (const bill of dated) {
    const month = bill.billing_period_start.slice(0, 7);
    const list = byStartMonth.get(month) ?? [];
    list.push(bill);
    byStartMonth.set(month, list);
  }

  const rows: TimelineRow<T>[] = [];
  const shown = new Set<T>();
  for (const month of monthsBetween(minStart, maxEnd)) {
    if (missing.has(month)) rows.push({ kind: "gap", month });
    const starting = [...(byStartMonth.get(month) ?? [])].sort((a, b) =>
      a.billing_period_start.localeCompare(b.billing_period_start),
    );
    for (const bill of starting) {
      rows.push({ kind: "bill", bill });
      shown.add(bill);
    }
  }
  for (const bill of dated) {
    if (!shown.has(bill)) rows.push({ kind: "bill", bill });
  }
  for (const bill of undated) rows.push({ kind: "bill", bill });
  return rows;
}
