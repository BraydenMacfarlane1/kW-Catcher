import { describe, expect, it } from "vitest";
import app from "../src/index";
import { CONTRACT_REQUIRED, csvExportColumns } from "../src/contract";
import type { MeterRow, SiteRow } from "../src/db";

const TOKEN = "test-token";

const site: SiteRow = {
  id: "site-1",
  name: "XU Holdings — Irwindale",
  created_at: "2026-01-01T00:00:00.000Z",
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

function fakeDb(): D1Database {
  const sites = [site];
  const meters = [meter];
  const bills = [january];
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
  if (sql.startsWith("SELECT id, name, created_at FROM sites ORDER BY name")) {
    return [...sites].sort((a, b) => a.name.localeCompare(b.name));
  }
  if (sql.startsWith("SELECT id, name, created_at FROM sites WHERE id = ?")) {
    return sites.filter((row) => row.id === params[0]);
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

function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: fakeDb(),
    BILLS: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    API_TOKEN: TOKEN,
    ...overrides,
  };
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
