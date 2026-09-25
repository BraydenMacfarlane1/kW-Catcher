import { beforeEach, describe, expect, it, vi } from "vitest";
import { CpuBudgetError, OcrCpuClock } from "../src/budget";
import app from "../src/index";
import { CONTRACT_REQUIRED, csvExportColumns } from "../src/contract";
import type { MeterRow, SiteRow } from "../src/db";

const ingestPdf = vi.hoisted(() => vi.fn());

vi.mock("../src/ingest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ingest")>();
  return { ...actual, ingestPdf };
});

const TOKEN = "test-token";

const site: SiteRow = {
  id: "site-1",
  name: "XU Holdings — Irwindale",
  created_at: "2026-01-01T00:00:00.000Z",
  utility: "",
  address: "",
  city: "",
  state: "",
  zip: "",
  notes: "",
  customer_name: "",
};

const meter: MeterRow = {
  id: "meter-row-1",
  site_id: site.id,
  meter_id: "259000-081267",
  utility: "SCE",
  customer_name: "XU Holdings",
  customer_account: "700123456789",
  service_account: "3001234567",
  pod_id: "",
  service_address: "1 Utility Way",
  service_city: "Irwindale",
  service_state: "CA",
  service_zip: "91706",
  created_at: "2026-01-01T00:00:00.000Z",
};

function bill(partial: Record<string, string>): Record<string, string> {
  const row: Record<string, string> = {
    updated_at: "2026-02-01T00:00:00.000Z",
    source_key: `${site.id}|row`,
    text_excerpt: "",
  };
  for (const column of csvExportColumns()) row[column] = "";
  return { ...row, ...partial };
}

const january = bill({
  id: "bill-1",
  site_id: site.id,
  meter_id: meter.meter_id,
  utility: "SCE",
  billing_period_start: "2025-01-01",
  billing_period_end: "2025-01-31",
  kwh_total: "1000",
  demand_kw_max: "40",
  kwh_on_peak: "100",
  kwh_mid_peak: "200",
  kwh_off_peak: "700",
  status: "ok",
  created_at: "2026-02-01T00:00:00.000Z",
});

function fakeDb(extraBills: Record<string, string>[] = []): D1Database {
  const sites = [site];
  const meters = [meter];
  const bills = [january, ...extraBills];
  return {
    prepare(sql: string) {
      let params: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          params = values;
          return statement;
        },
        async all() {
          return { results: rows(sql, params, sites, meters, bills), success: true, meta: {} };
        },
        async first<T>() {
          return (rows(sql, params, sites, meters, bills)[0] ?? null) as T | null;
        },
        async run() {
          if (sql.startsWith("INSERT INTO sites")) {
            sites.push({
              id: String(params[0]),
              name: String(params[1]),
              created_at: String(params[2]),
              utility: String(params[3] ?? ""),
              address: String(params[4] ?? ""),
              city: String(params[5] ?? ""),
              state: String(params[6] ?? ""),
              zip: String(params[7] ?? ""),
              notes: String(params[8] ?? ""),
              customer_name: String(params[9] ?? ""),
            });
            return { success: true, meta: {} };
          }
          throw new Error(`unexpected sql: ${sql}`);
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

function rows(
  sql: string,
  params: unknown[],
  sites: SiteRow[],
  meters: MeterRow[],
  bills: Record<string, string>[],
): object[] {
  if (sql.startsWith("SELECT id, name, created_at, utility, address, city, state, zip, notes, customer_name FROM sites ORDER BY name")) {
    return [...sites].sort((a, b) => a.name.localeCompare(b.name));
  }
  if (sql.startsWith("SELECT id, name, created_at, utility, address, city, state, zip, notes, customer_name FROM sites WHERE id = ?")) {
    return sites.filter((row) => row.id === params[0]);
  }
  if (sql.startsWith("SELECT id FROM sites WHERE name = ?")) {
    return sites.filter((row) => row.name === params[0]).map((row) => ({ id: row.id }));
  }
  if (sql.startsWith("SELECT * FROM meters WHERE site_id = ?")) {
    return meters
      .filter((row) => row.site_id === params[0])
      .sort((a, b) => a.meter_id.localeCompare(b.meter_id));
  }
  if (sql.includes("FROM bills WHERE site_id = ? AND meter_id = ?")) {
    return bills.filter((row) => row.site_id === params[0] && row.meter_id === params[1]);
  }
  if (sql.includes("FROM bills WHERE site_id = ?")) {
    return bills.filter((row) => row.site_id === params[0]);
  }
  if (sql.startsWith("SELECT site_id, meter_id, billing_period_start")) {
    return bills.map((row) => ({
      site_id: row.site_id,
      meter_id: row.meter_id,
      billing_period_start: row.billing_period_start,
      billing_period_end: row.billing_period_end,
    }));
  }
  if (sql.startsWith("SELECT site_id, meter_id FROM meters")) {
    return meters.map((row) => ({ site_id: row.site_id, meter_id: row.meter_id }));
  }
  throw new Error(`unexpected sql: ${sql}`);
}

function env(overrides: Partial<Env> = {}, extraBills: Record<string, string>[] = []): Env {
  return {
    DB: fakeDb(extraBills),
    BILLS: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    API_TOKEN: TOKEN,
    ...overrides,
  } as Env;
}

function bearer(token = TOKEN): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

describe("read API", () => {
  it("rejects /api/v1 without a token", async () => {
    const res = await app.request("/api/v1/sites", {}, env());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects a wrong token and a missing secret", async () => {
    const wrong = await app.request("/api/v1/sites", {
      headers: { ...bearer("nope"), Origin: "https://sun-daddy.pages.dev" },
    }, env());
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "unauthorized" });
    expect(wrong.headers.get("access-control-allow-origin")).toBe("https://sun-daddy.pages.dev");

    const unset = await app.request("/api/v1/sites/missing/export.json", { headers: bearer() }, env({ API_TOKEN: undefined }));
    expect(unset.status).toBe(401);
  });

  it("lists sites and nested meters", async () => {
    const res = await app.request("/api/v1/sites", { headers: bearer() }, env());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual([
      {
        id: site.id,
        name: site.name,
        created_at: site.created_at,
        utility: "",
        address: "",
        city: "",
        state: "",
        zip: "",
        notes: "",
        customer_name: "",
        meters: [meter],
      },
    ]);
  });

  it("accepts X-API-Token", async () => {
    const res = await app.request("/api/v1/sites", { headers: { "X-API-Token": TOKEN } }, env());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("serves meter CSV with the contract columns and the same bytes as the UI export", async () => {
    const headers = bearer();
    const api = await app.request(
      `/api/v1/sites/${site.id}/meters/${meter.meter_id}/export.csv`,
      { headers },
      env(),
    );
    const ui = await app.request(`/sites/${site.id}/meters/${meter.meter_id}/export.csv`, {}, env());
    expect(api.status).toBe(200);
    expect(ui.status).toBe(200);
    const csv = await api.text();
    expect(await ui.text()).toBe(csv);
    const header = csv.split("\n")[0]?.split(",") ?? [];
    for (const column of CONTRACT_REQUIRED) {
      expect(header).toContain(column);
    }
    expect(header).toEqual([...csvExportColumns()]);
    expect(api.headers.get("content-type")).toContain("text/csv");
    expect(api.headers.get("content-disposition")).toBe(ui.headers.get("content-disposition"));
  });

  it("serves meter and site JSON with the CSV keys", async () => {
    const meterJson = await app.request(
      `/api/v1/sites/${site.id}/meters/${meter.meter_id}/export.json`,
      { headers: bearer() },
      env(),
    );
    expect(meterJson.status).toBe(200);
    const rows = (await meterJson.json()) as Record<string, string>[];
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0])).toEqual([...csvExportColumns()]);
    expect(rows[0].billing_period_start).toBe("2025-01-01");
    expect(rows[0].kwh_total).toBe("1000");
    expect(rows[0].kwh_super_off_peak).toBe("");

    const siteJson = await app.request(`/api/v1/sites/${site.id}/export.json`, { headers: bearer() }, env());
    const siteRows = (await siteJson.json()) as Record<string, string>[];
    expect(siteRows).toEqual(rows);

    const siteCsv = await app.request(`/api/v1/sites/${site.id}/export.csv`, { headers: bearer() }, env());
    const uiCsv = await app.request(`/sites/${site.id}/export.csv`, {}, env());
    expect(await siteCsv.text()).toBe(await uiCsv.text());
  });

  it("keeps /api/health public and answers CORS preflight without a token", async () => {
    const health = await app.request("/api/health", {}, env({ API_TOKEN: undefined }));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const preflight = await app.request("/api/v1/sites", {
      method: "OPTIONS",
      headers: {
        Origin: "https://preview.sun-daddy.pages.dev",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization,x-api-token",
      },
    }, env());
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://preview.sun-daddy.pages.dev");
    expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");
    expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("x-api-token");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("GET");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
    expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("content-type");

    const postPreflight = await app.request("/api/v1/sites", {
      method: "OPTIONS",
      headers: {
        Origin: "https://sun-daddy.pages.dev",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    }, env());
    expect(postPreflight.status).toBe(204);
    expect(postPreflight.headers.get("access-control-allow-origin")).toBe("https://sun-daddy.pages.dev");
    expect(postPreflight.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("echoes only allowlisted origins and lets CORS_ORIGINS replace the default", async () => {
    const allowed = await app.request("/api/v1/sites", {
      headers: { ...bearer(), Origin: "https://sun-daddy.pages.dev" },
    }, env());
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://sun-daddy.pages.dev");

    const blocked = await app.request("/api/v1/sites", {
      headers: { ...bearer(), Origin: "https://evil.example" },
    }, env());
    expect(blocked.status).toBe(200);
    expect(blocked.headers.get("access-control-allow-origin")).toBeNull();

    const replaced = await app.request("/api/v1/sites", {
      method: "OPTIONS",
      headers: { Origin: "https://sun-daddy.pages.dev", "Access-Control-Request-Method": "GET" },
    }, env({ CORS_ORIGINS: "http://localhost:5173" }));
    expect(replaced.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("leaves the HTML home page unauthenticated", async () => {
    const res = await app.request("/", {}, env({ API_TOKEN: undefined }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("XU Holdings");
  });

  it("returns JSON 404 for an unknown API meter and JSON 404 for an unknown path", async () => {
    const missing = await app.request(
      `/api/v1/sites/${site.id}/meters/not-a-meter/export.json`,
      { headers: bearer() },
      env(),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });

    const unknown = await app.request("/api/v1/nope", { headers: bearer() }, env());
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "not_found" });
  });
});

function pdfFile(name: string): File {
  return new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], name, { type: "application/pdf" });
}

describe("write API", () => {
  beforeEach(() => {
    ingestPdf.mockReset();
  });

  it("rejects POST /api/v1/sites without a token", async () => {
    const res = await app.request("/api/v1/sites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Acme Warehouse" }),
    }, env());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("creates a site and returns the list-item shape", async () => {
    const database = fakeDb();
    const res = await app.request("/api/v1/sites", {
      method: "POST",
      headers: { ...bearer(), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "  Acme Warehouse  ",
        utility: "SCE",
        address: "1 Dock St",
        city: "Irwindale",
        state: "CA",
        zip: "91706",
        notes: "dock",
        customer_name: "Acme",
        ignored: true,
      }),
    }, env({ DB: database }));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const created = (await res.json()) as SiteRow & { meters: MeterRow[] };
    expect(created).toMatchObject({
      name: "Acme Warehouse",
      utility: "SCE",
      address: "1 Dock St",
      city: "Irwindale",
      state: "CA",
      zip: "91706",
      notes: "dock",
      customer_name: "Acme",
      meters: [],
    });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);

    const got = await app.request(`/api/v1/sites/${created.id}`, { headers: bearer() }, env({ DB: database }));
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual({
      id: created.id,
      name: created.name,
      created_at: created.created_at,
      utility: "SCE",
      address: "1 Dock St",
      city: "Irwindale",
      state: "CA",
      zip: "91706",
      notes: "dock",
      customer_name: "Acme",
      meters: [],
      bill_counts: { ok: 0, needs_parser: 0, needs_password: 0, failed: 0, total: 0 },
    });
  });

  it("returns 409 when the site name already exists", async () => {
    const res = await app.request("/api/v1/sites", {
      method: "POST",
      headers: { ...bearer(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: site.name }),
    }, env());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "name_taken" });
  });

  it("returns 404 when uploading to an unknown site", async () => {
    const form = new FormData();
    form.append("pdf", pdfFile("bill.pdf"));
    const res = await app.request("/api/v1/sites/missing-site/bills", {
      method: "POST",
      headers: bearer(),
      body: form,
    }, env());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(ingestPdf).not.toHaveBeenCalled();
  });

  it("ingests pdfs and pdf files and returns snake_case results", async () => {
    ingestPdf.mockImplementation(async (_env: Env, _siteId: string, file: File) => [
      {
        sourceFile: file.name,
        meterId: meter.meter_id,
        status: "ok",
        detail: `inserted ok meter ${meter.meter_id}`,
      },
    ]);
    const form = new FormData();
    form.append("pdfs", pdfFile("bill1.pdf"));
    form.append("pdfs", pdfFile("bill2.pdf"));
    form.append("pdf", pdfFile("bill3.pdf"));
    form.append("pdf_password", " secret ");
    const res = await app.request(`/api/v1/sites/${site.id}/bills`, {
      method: "POST",
      headers: bearer(),
      body: form,
    }, env());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      site_id: site.id,
      results: [1, 2, 3].map((index) => ({
        source_file: `bill${index}.pdf`,
        meter_id: meter.meter_id,
        status: "ok",
        detail: `inserted ok meter ${meter.meter_id}`,
      })),
      counts: { ok: 3, needs_parser: 0, needs_password: 0, failed: 0, rejected: 0 },
      meters: [meter],
    });
    expect(ingestPdf).toHaveBeenCalledTimes(3);
    expect(ingestPdf.mock.calls[0]?.[1]).toBe(site.id);
    expect(ingestPdf.mock.calls[0]?.[2]).toBeInstanceOf(File);
    expect((ingestPdf.mock.calls[0]?.[2] as File).name).toBe("bill1.pdf");
    const firstOptions = ingestPdf.mock.calls[0]?.[3] as { password?: string; cpuClock?: OcrCpuClock };
    const thirdOptions = ingestPdf.mock.calls[2]?.[3] as { cpuClock?: OcrCpuClock };
    expect(firstOptions.password).toBe("secret");
    expect(firstOptions.cpuClock).toBeInstanceOf(OcrCpuClock);
    expect(thirdOptions.cpuClock).toBe(firstOptions.cpuClock);
    expect((ingestPdf.mock.calls[2]?.[2] as File).name).toBe("bill3.pdf");
  });

  it("returns JSON when OCR runs past the CPU budget", async () => {
    ingestPdf.mockRejectedValue(new CpuBudgetError());
    const form = new FormData();
    form.append("pdf", pdfFile("bill.pdf"));
    const res = await app.request(`/api/v1/sites/${site.id}/bills`, {
      method: "POST",
      headers: bearer(),
      body: form,
    }, env());
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "cpu_budget" });
  });

  it("rejects files past the 25 file limit", async () => {
    ingestPdf.mockImplementation(async (_env: Env, _siteId: string, file: File) => [
      { sourceFile: file.name, meterId: "", status: "needs_parser", detail: "saved" },
    ]);
    const form = new FormData();
    for (let index = 0; index < 26; index += 1) {
      form.append("pdfs", pdfFile(`b${index}.pdf`));
    }
    const res = await app.request(`/api/v1/sites/${site.id}/bills`, {
      method: "POST",
      headers: bearer(),
      body: form,
    }, env());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: { source_file: string; meter_id: string; status: string; detail?: string }[];
      counts: Record<string, number>;
    };
    expect(ingestPdf).toHaveBeenCalledTimes(25);
    expect(body.counts).toEqual({ ok: 0, needs_parser: 25, needs_password: 0, failed: 0, rejected: 1 });
    expect(body.results[25]).toEqual({
      source_file: "b25.pdf",
      meter_id: "",
      status: "rejected",
      detail: "limit 25 files",
    });
  });

  it("counts needs_password bills separately from failed", async () => {
    const locked = bill({
      id: "bill-locked",
      site_id: site.id,
      meter_id: meter.meter_id,
      status: "failed",
      notes: "needs_password: PDF is password-protected",
      source_key: `${site.id}|locked`,
    });
    const failed = bill({
      id: "bill-failed",
      site_id: site.id,
      meter_id: meter.meter_id,
      status: "failed",
      notes: "MISSING_REQUIRED:kwh_total",
      source_key: `${site.id}|failed`,
    });
    const res = await app.request(`/api/v1/sites/${site.id}`, { headers: bearer() }, env({}, [locked, failed]));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bill_counts: Record<string, number>; meters: MeterRow[] };
    expect(body.meters).toEqual([meter]);
    expect(body.bill_counts).toEqual({ ok: 1, needs_parser: 0, needs_password: 1, failed: 1, total: 3 });
  });

  it("returns 404 for a missing site", async () => {
    const missing = await app.request("/api/v1/sites/missing-site", { headers: bearer() }, env());
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });

    const badId = await app.request("/api/v1/sites/bad%20id", { headers: bearer() }, env());
    expect(badId.status).toBe(404);
  });
});
