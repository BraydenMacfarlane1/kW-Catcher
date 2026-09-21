import { Hono } from "hono";
import { toCsv } from "./csv";
import { csvExportColumns } from "./contract";
import {
  createSite,
  getSite,
  listBillKeys,
  listBills,
  listMeterKeys,
  listMeters,
  listSites,
} from "./db";
import { missingMonths } from "./gaps";
import { ingestPdf, reparseStoredBills, type IngestResult } from "./ingest";
import { page, renderBanner, renderHome, renderSite } from "./pages";

const app = new Hono<{ Bindings: Env }>();

app.onError((error, c) => {
  console.error(JSON.stringify({ message: error.message }));
  return c.html(page("Error", "<h1>Something went wrong.</h1><p><a href=\"/\">Back to sites</a></p>"), 500);
});

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/", async (c) => {
  try {
    const [sites, bills, meters] = await Promise.all([
      listSites(c.env.DB),
      listBillKeys(c.env.DB),
      listMeterKeys(c.env.DB),
    ]);
    const entries = sites.map((site) => {
      const siteBills = bills.filter((bill) => bill.site_id === site.id);
      const siteMeters = meters.filter((meter) => meter.site_id === site.id);
      let gaps = 0;
      for (const meter of siteMeters) {
        gaps += missingMonths(siteBills.filter((bill) => bill.meter_id === meter.meter_id)).length;
      }
      return { site, meters: siteMeters.length, bills: siteBills.length, gaps };
    });
    const banner = renderBanner(c.req.query("notice") ?? null, queryCounts(c));
    return c.html(renderHome(entries, banner));
  } catch (error) {
    if (isMissingTable(error)) {
      return c.html(renderHome([], renderBanner("setup", {})));
    }
    throw error;
  }
});

app.post("/sites", async (c) => {
  const body = await c.req.parseBody();
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 200) return c.redirect("/?notice=name", 303);
  const site = await createSite(c.env.DB, name);
  return c.redirect(`/sites/${site.id}?notice=created`, 303);
});

app.get("/sites/:id", async (c) => {
  const id = c.req.param("id");
  if (!isId(id)) return c.notFound();
  const site = await getSite(c.env.DB, id);
  if (!site) return c.notFound();
  const [meters, bills] = await Promise.all([listMeters(c.env.DB, id), listBills(c.env.DB, id)]);
  return c.html(
    renderSite({
      site,
      meters,
      bills,
      banner: renderBanner(c.req.query("notice") ?? null, queryCounts(c)),
    }),
  );
});

app.post("/sites/:id/upload", async (c) => {
  const id = c.req.param("id");
  if (!isId(id)) return c.notFound();
  const site = await getSite(c.env.DB, id);
  if (!site) return c.notFound();
  const form = await c.req.formData();
  const files = form.getAll("pdfs").filter((entry): entry is File => entry instanceof File && entry.size > 0);
  const results: IngestResult[] = [];
  for (const file of files.slice(0, 25)) {
    results.push(...(await ingestPdf(c.env, id, file)));
  }
  for (const file of files.slice(25)) {
    results.push({ sourceFile: file.name || "bill.pdf", meterId: "", status: "rejected", detail: "limit 25 files" });
  }
  return c.redirect(resultLocation(id, "uploaded", results), 303);
});

app.post("/sites/:id/reparse", async (c) => {
  const id = c.req.param("id");
  if (!isId(id)) return c.notFound();
  const site = await getSite(c.env.DB, id);
  if (!site) return c.notFound();
  const results = await reparseStoredBills(c.env, id);
  return c.redirect(resultLocation(id, "reparsed", results), 303);
});

app.get("/sites/:id/export.csv", async (c) => {
  const id = c.req.param("id");
  if (!isId(id)) return c.notFound();
  const site = await getSite(c.env.DB, id);
  if (!site) return c.notFound();
  const bills = await listBills(c.env.DB, id);
  const filename = `${fileSlug(site.name)}_all-meters.csv`;
  return csvResponse(bills, filename);
});

app.get("/sites/:id/meters/:meterId/export.csv", async (c) => {
  const id = c.req.param("id");
  const meterId = c.req.param("meterId");
  if (!isId(id) || !isMeterId(meterId)) return c.notFound();
  const site = await getSite(c.env.DB, id);
  if (!site) return c.notFound();
  const bills = await listBills(c.env.DB, id, meterId);
  if (bills.length === 0) return c.notFound();
  const filename = `${fileSlug(site.name)}_${fileSlug(meterId)}.csv`;
  return csvResponse(bills, filename);
});

app.notFound((c) => c.html(page("Not found", "<h1>Not found</h1><p><a href=\"/\">Back to sites</a></p>"), 404));

export default app;

function isId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,80}$/.test(id);
}

function isMeterId(meterId: string): boolean {
  return /^[A-Za-z0-9_.-]{1,80}$/.test(meterId);
}

function fileSlug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_") || "export";
}

function csvResponse(bills: Awaited<ReturnType<typeof listBills>>, filename: string): Response {
  const columns = csvExportColumns();
  const csv = toCsv(
    columns,
    bills.map((bill) => ({
      ...bill,
      r2_key: bill.r2_key ?? "",
    })),
  );
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

function isMissingTable(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}

function queryCounts(c: { req: { query: (name: string) => string | undefined } }): Record<string, string> {
  const counts: Record<string, string> = {};
  for (const key of ["ok", "needs_parser", "failed", "rejected"]) {
    const value = c.req.query(key);
    counts[key] = value && /^\d+$/.test(value) ? value : "0";
  }
  return counts;
}

function resultLocation(siteId: string, notice: string, results: IngestResult[]): string {
  const counts = { ok: 0, needs_parser: 0, failed: 0, rejected: 0 };
  for (const result of results) counts[result.status] += 1;
  const params = new URLSearchParams({ notice, ...Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, String(value)])) });
  return `/sites/${siteId}?${params.toString()}`;
}

