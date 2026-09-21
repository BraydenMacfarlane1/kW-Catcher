import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/csv";
import { BILL_COLUMNS } from "../src/parsers/base";
import { parseDocument } from "../src/parsers/registry";
import { parseSceBill, sceParser } from "../src/parsers/sce";
import { extractPdfText } from "../src/pdf";

const csv = parseCsv(readFileSync(new URL("../seed/xu-holdings-sce-12mo.csv", import.meta.url), "utf8"));
const summer = csv.find((row) => row.source_file === "bill0-original.pdf");

function expectRow(actual: Record<string, string>, expected: Record<string, string>): void {
  for (const column of BILL_COLUMNS) {
    expect(actual[column], column).toBe(expected[column] ?? "");
  }
}

describe("SCE parser", () => {
  it("matches the CSV header", () => {
    expect(Object.keys(csv[0] ?? {})).toEqual([...BILL_COLUMNS]);
    expect(summer).toBeTruthy();
  });

  it("parses unpdf text for the sample bill", () => {
    const text = readFileSync(new URL("./fixtures/bill0-unpdf.txt", import.meta.url), "utf8");
    expect(sceParser.match(text)).toBe(true);
    const row = parseSceBill(text, "bill0-original.pdf");
    expectRow(row, summer ?? {});
  });

  it("parses pdftotext -layout text for the sample bill", () => {
    const text = readFileSync(new URL("./fixtures/bill0-pdftotext.txt", import.meta.url), "utf8");
    const row = parseSceBill(text, "bill0-original.pdf");
    expectRow(row, summer ?? {});
  });

  it("parses the sample PDF through unpdf", async () => {
    const bytes = new Uint8Array(readFileSync(new URL("./fixtures/bill0-original.pdf", import.meta.url)));
    const text = await extractPdfText(bytes);
    const outcome = parseDocument(text, "bill0-original.pdf");
    expect(outcome.status).toBe("ok");
    expectRow(outcome.fields, summer ?? {});
  });

  it("parses a winter TOU bill with super-off before off peak", () => {
    const text = `XU HOLDINGS, LLC / Page 1 of 6
Customer account
700332402169
Service account
8001137455
14808 LOS ANGELES ST
IRWINDALE, CA 91706
Amount due $1,809.46
Due by 12/19/25
Southern California Edison
www.sce.com
POD-ID
101760940008131289
Date bill prepared
11/29/25
Usage Avg. cost Total cost
Super off peak 3109 kWh x $0.10 = $1.00
Mid peak 1167 kWh x $0.10 = $1.00
Off peak 1242 kWh x $0.10 = $1.00
5518 kWh $776.25 Energy Charges
$604.10 Demand Charges
$429.11 Other credits/charges
$1,809.46 Total
Winter season demand (kW)
Your maximum demand reached this billing period is 35 kW Maximum Winter demand reached by price period :
Super off peak 29 kW 11/03/25 01:00am-01:15am
Mid peak 35 kW 11/01/25 04:15pm-04:30pm
Off peak 13 kW 11/02/25 03:45pm-04:00pm
To view your demand charges, please refer to the Details of your new charges.
For meter 259000-081267 from 10/28/25 to 11/28/25
Total electricity you used this month in kWh 5,518
Your rate: TOU-GS-2-E
Billing period: 10/28/25 to 11/28/25 (32 days)
Service voltage: 480 volts
USCA-SCSC-1600-0000
`;
    const row = parseSceBill(text, "bill3.pdf");
    expect(row.kwh_on_peak).toBe("");
    expect(row.kwh_mid_peak).toBe("1167");
    expect(row.kwh_off_peak).toBe("1242");
    expect(row.kwh_super_off_peak).toBe("3109");
    expect(row.kwh_total).toBe("5518");
    expect(row.demand_kw_max).toBe("35");
    expect(row.demand_kw_on_peak).toBe("");
    expect(row.demand_kw_mid_peak).toBe("35");
    expect(row.demand_kw_off_peak).toBe("13");
    expect(row.demand_kw_super_off_peak).toBe("29");
    expect(row.billing_period_start).toBe("2025-10-28");
    expect(row.billing_period_end).toBe("2025-11-28");
    expect(row.notes).toContain("winter TOU (no on-peak)");
    expect(row.parse_confidence).toBe("1.00");
    expect(parseDocument(text, "bill3.pdf").status).toBe("ok");
  });

  it("parses a summer/winter transition and keeps the max demand in each period", () => {
    const text = `XU HOLDINGS, LLC / Page 1 of 6
Customer account
700332402169
Service account
8001137455
14808 LOS ANGELES ST
IRWINDALE, CA 91706
Amount due $1,573.75
Due by 11/17/25
www.sce.com
POD-ID
101760940008131289
Date bill prepared
10/28/25
Usage Avg. cost Total cost
On peak 70 kWh x $0.10 = $1.00
Mid peak 833 kWh x $0.10 = $1.00
Off peak 1317 kWh x $0.10 = $1.00
Super off peak 2488 kWh x $0.10 = $1.00
4708 kWh $720.64 Energy Charges
$448.98 Demand Charges
$404.13 Other credits/charges
$1,573.75 Total
Summer and Winter season demand (kW)
Your maximum demand reached this billing period is 26 kW Maximum Summer and Winter demand reached by price period :
On peak 19 kW 10/01/25 04:15pm-04:30pm
Mid peak 0 kW 10/02/25 08:15pm-08:30pm
Off peak 19 kW 10/03/25 03:45pm-04:00pm
Winter
Mid peak 26 kW 10/20/25 08:15pm-08:30pm
Off peak 16 kW 10/21/25 03:45pm-04:00pm
Super off peak 26 kW 10/22/25 01:00am-01:15am
To view your demand charges.
For meter 259000-081267 from 09/29/25 to 10/27/25
Total estimated electricity usage this month in kWh 4,708
Your rate: TOU-GS-2-E
Billing period: 09/29/25 to 10/27/25 (29 days)
Service voltage: 480 volts
USCA-SCSC-1600-0000
`;
    const row = parseSceBill(text, "bill2.pdf");
    expect(row.kwh_on_peak).toBe("70");
    expect(row.kwh_mid_peak).toBe("833");
    expect(row.kwh_off_peak).toBe("1317");
    expect(row.kwh_super_off_peak).toBe("2488");
    expect(row.demand_kw_on_peak).toBe("19");
    expect(row.demand_kw_mid_peak).toBe("26");
    expect(row.demand_kw_off_peak).toBe("19");
    expect(row.demand_kw_super_off_peak).toBe("26");
    expect(row.demand_kw_max).toBe("26");
    expect(row.notes).toContain("transition summer/winter TOU");
    expect(row.parse_confidence).toBe("1.00");
  });

  it("does not invent fields when no parser matches", () => {
    const text = "Pacific Gas and Electric\nCustomer account\n1234567890\nAmount due $10.00\n";
    const outcome = parseDocument(text, "pge.pdf");
    expect(outcome.status).toBe("needs_parser");
    expect(outcome.fields.utility).toBe("");
    expect(outcome.fields.customer_account).toBe("");
    expect(outcome.fields.kwh_total).toBe("");
    expect(outcome.fields.amount_due_usd).toBe("");
    expect(outcome.fields.parser_id).toBe("");
    expect(outcome.textExcerpt).toContain("Pacific Gas and Electric");
  });

  it("marks an SCE bill failed when required fields are missing", () => {
    const text = "Southern California Edison\nwww.sce.com\nCustomer account\nBilling period: not a date\n";
    const outcome = parseDocument(text, "broken.pdf");
    expect(sceParser.match(text)).toBe(true);
    expect(outcome.status).toBe("failed");
    expect(outcome.fields.utility).toBe("SCE");
    expect(outcome.fields.notes).toContain("MISSING_REQUIRED:");
  });
});
