import { csvExportColumns } from "./contract";
import { toCsv } from "./csv";
import { ESTIMATION_METHOD, isEstimated, type ExportBill } from "./estimate";

/** One object per bill period. Keys match the CSV header, in that order. Values are CSV cells (strings). */
export function billExportRecord(bill: ExportBill): Record<string, string> {
  const source = bill as unknown as Record<string, string | null | undefined>;
  const estimated = isEstimated(bill);
  const record: Record<string, string> = {};
  for (const column of csvExportColumns()) {
    if (column === "estimated") record[column] = estimated ? "true" : "false";
    else if (column === "estimation_method") record[column] = estimated ? (bill.estimation_method ?? ESTIMATION_METHOD) : "";
    else record[column] = (column === "r2_key" ? bill.r2_key : source[column]) ?? "";
  }
  return record;
}

export function billExportRecords(bills: readonly ExportBill[]): Record<string, string>[] {
  return bills.map(billExportRecord);
}

export function billsToCsv(bills: readonly ExportBill[]): string {
  return toCsv(csvExportColumns(), billExportRecords(bills));
}

export function csvResponse(bills: readonly ExportBill[], filename: string): Response {
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
