import { timelineRows, type TimelineRow } from "./gaps";
import type { BillRow, MeterRow, SiteRow } from "./db";

const TABLE_COLUMNS: { key: keyof BillRow; label: string }[] = [
  { key: "status", label: "Status" },
  { key: "billing_period_start", label: "Start" },
  { key: "billing_period_end", label: "End" },
  { key: "billing_days", label: "Days" },
  { key: "kwh_total", label: "kWh" },
  { key: "kwh_on_peak", label: "On" },
  { key: "kwh_mid_peak", label: "Mid" },
  { key: "kwh_off_peak", label: "Off" },
  { key: "kwh_super_off_peak", label: "Super" },
  { key: "demand_kw_max", label: "kW max" },
  { key: "amount_due_usd", label: "Amount due" },
  { key: "source_file", label: "Source" },
  { key: "parse_confidence", label: "Conf" },
];

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} · kW-Catcher</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="top">
    <a href="/">kW-Catcher</a>
    <span>Sites, meters, and bill history</span>
  </header>
  <main>${body}</main>
</body>
</html>`;
}

export function renderHome(sites: { site: SiteRow; meters: number; bills: number; gaps: number }[], banner: string): string {
  const rows = sites.length
    ? sites
        .map(
          (entry) => `<tr>
            <td><a href="/sites/${esc(entry.site.id)}">${esc(entry.site.name)}</a></td>
            <td>${entry.meters}</td>
            <td>${entry.bills}</td>
            <td>${entry.gaps === 0 ? "0" : `<strong>${entry.gaps}</strong>`}</td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="4">No sites yet. Create one, or apply the D1 migrations to load the XU Holdings seed.</td></tr>`;

  return page(
    "Sites",
    `${banner}
    <h1>Sites</h1>
    <table>
      <thead><tr><th>Site</th><th>Meters</th><th>Bills</th><th>Missing months</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <h2>New site</h2>
    <form method="post" action="/sites">
      <label>Name <input name="name" required maxlength="200" placeholder="Site name"></label>
      <button type="submit">Create site</button>
    </form>`,
  );
}

export function renderSite(input: {
  site: SiteRow;
  meters: MeterRow[];
  bills: BillRow[];
  banner: string;
}): string {
  const metersByNumber = new Map(input.meters.map((meter) => [meter.meter_id, meter]));
  const groups = new Map<string, BillRow[]>();
  for (const bill of input.bills) {
    const key = bill.meter_id || "";
    const list = groups.get(key) ?? [];
    list.push(bill);
    groups.set(key, list);
  }
  const sections = groups.size === 0
    ? `<section><p>No bills yet.</p></section>`
    : [...groups.entries()]
        .sort((a, b) => compareMeterIds(a[0], b[0]))
        .map(([meterId, bills]) => renderMeter(input.site.id, meterId, metersByNumber.get(meterId), bills))
        .join("");

  return page(
    input.site.name,
    `${input.banner}
    <p class="crumb"><a href="/">Sites</a> / ${esc(input.site.name)}</p>
    <div class="title-row">
      <h1>${esc(input.site.name)}</h1>
      <a class="button" href="/sites/${esc(input.site.id)}/export.csv">All meters CSV</a>
    </div>
    <section class="upload">
      <h2>Upload bills</h2>
      <form method="post" action="/sites/${esc(input.site.id)}/upload" enctype="multipart/form-data">
        <label>PDF files <input type="file" name="pdfs" accept="application/pdf,.pdf" multiple required></label>
        <button type="submit">Upload and parse</button>
      </form>
      <form method="post" action="/sites/${esc(input.site.id)}/reparse">
        <button type="submit">Re-parse stored PDFs</button>
      </form>
      <p class="hint">A PDF with several meters becomes one row per meter, sharing the stored file. kWh and demand are never added together. Unknown utilities are saved as <code>needs_parser</code> with the PDF and a text excerpt. Fields are left blank.</p>
    </section>
    ${sections}`,
  );
}

function compareMeterIds(a: string, b: string): number {
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b);
}

function renderMeter(siteId: string, meterId: string, meter: MeterRow | undefined, bills: BillRow[]): string {
  const title = meterId ? `Meter ${meterId}` : "No meter id";
  const download = meterId
    ? `<a href="/sites/${esc(siteId)}/meters/${encodeURIComponent(meterId)}/export.csv">Download this meter</a>`
    : "";
  const address = meter
    ? [meter.service_address, meter.service_city, meter.service_state, meter.service_zip].filter(Boolean).join(", ")
    : "";
  const rows = meterId ? timelineRows(bills) : bills.map((bill) => ({ kind: "bill" as const, bill }));
  const gapCount = rows.filter((row) => row.kind === "gap").length;
  const gapNote = meterId
    ? gapCount === 0
      ? `<p class="ok-note">No missing months between the first and last bill.</p>`
      : `<p class="gap-note">${gapCount} missing month${gapCount === 1 ? "" : "s"} highlighted below.</p>`
    : "";

  return `<section>
    <div class="title-row">
      <h2>${esc(title)}</h2>
      ${download}
    </div>
    ${address ? `<p class="meta">${esc(address)}${meter?.utility ? ` · ${esc(meter.utility)}` : ""}</p>` : ""}
    ${gapNote}
    <div class="table-wrap">
      <table>
        <thead><tr>${TABLE_COLUMNS.map((column) => `<th>${column.label}</th>`).join("")}<th>Notes</th></tr></thead>
        <tbody>${rows.length ? rows.map(renderRow).join("") : `<tr><td colspan="${TABLE_COLUMNS.length + 1}">No bills yet.</td></tr>`}</tbody>
      </table>
    </div>
    ${renderExcerpts(bills)}
  </section>`;
}

function renderRow(row: TimelineRow<BillRow>): string {
  if (row.kind === "gap") {
    return `<tr class="gap"><td colspan="${TABLE_COLUMNS.length + 1}">Missing month ${esc(row.month)} — no bill covers this month</td></tr>`;
  }
  const bill = row.bill;
  const cells = TABLE_COLUMNS.map((column) => `<td>${esc(String(bill[column.key] ?? ""))}</td>`).join("");
  return `<tr class="status-${esc(bill.status)}">${cells}<td>${esc(bill.notes)}</td></tr>`;
}

function renderExcerpts(bills: BillRow[]): string {
  const pending = bills.filter((bill) => bill.status !== "ok" && bill.text_excerpt);
  if (pending.length === 0) return "";
  return pending
    .map(
      (bill) => `<details>
        <summary>${esc(bill.source_file || "Bill")} text excerpt (${esc(bill.status)})</summary>
        <pre>${esc(bill.text_excerpt)}</pre>
      </details>`,
    )
    .join("");
}

export function renderBanner(notice: string | null, counts: Record<string, string>): string {
  if (notice === "created") return `<p class="banner">Site created.</p>`;
  if (notice === "name") return `<p class="banner warn">Enter a site name.</p>`;
  if (notice === "uploaded" || notice === "reparsed") {
    const label = notice === "uploaded" ? "Upload" : "Re-parse";
    const parts = ["ok", "needs_parser", "failed", "rejected"]
      .map((key) => `${counts[key] ?? "0"} ${key}`)
      .join(", ");
    return `<p class="banner">${esc(label)} finished: ${esc(parts)}.</p>`;
  }
  if (notice === "setup") {
    return `<p class="banner warn">Database is not migrated. Run <code>npm run db:migrate:local</code> then reload.</p>`;
  }
  return "";
}

export function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
