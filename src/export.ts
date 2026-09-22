import { csvExportColumns } from "./contract";
import { toCsv } from "./csv";
import type { BillRow } from "./db";

/** One object per bill period. Keys match the CSV header, in that order. Values are CSV cells (strings). */
export function billExportRecord(bill: BillRow): Record<string, string> {
  const source = bill as unknown as Record<string, string | null | undefined>;
  const record: Record<string, string> = {};
  for (const column of csvExportColumns()) {
    const value = column === "r2_key" ? bill.r2_key : source[column];
    record[column] = value ?? "";
  }
  return record;
}

export function billExportRecords(bills: readonly BillRow[]): Record<string, string>[] {
  return bills.map(billExportRecord);
}

export function billsToCsv(bills: readonly BillRow[]): string {
  return toCsv(csvExportColumns(), billExportRecords(bills));
}

export function csvResponse(bills: readonly BillRow[], filename: string): Response {
  return new Response(billsToCsv(bills), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

export function fileSlug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_") || "export";
}
