import { describe, expect, it } from "vitest";
import app from "../src/index";
import type { MeterRow, SiteRow } from "../src/db";

const TOKEN = "test-token";

const probe: SiteRow = {
  id: "probe",
  name: "Probe <auth> & co",
  created_at: "2026-03-01T00:00:00.000Z",
  utility: "",
  address: "",
  city: "",
  state: "",
  zip: "",
  notes: "",
  customer_name: "",
};

const keep: SiteRow = {
  id: "keep",
  name: "Keep me",
  created_at: "2026-03-02T00:00:00.000Z",
  utility: "SCE",
  address: "1 Stay St",
  city: "Irwindale",
  state: "CA",
  zip: "91706",
  notes: "",
  customer_name: "Keep",
};

function meter(siteId: string, meterId: string): MeterRow {
  return {
    id: `meter-${siteId}-${meterId}`,
    site_id: siteId,
    meter_id: meterId,
    utility: "SCE",
    customer_name: "",
    customer_account: "",
    service_account: "",
    pod_id: "",
    service_address: "",
    service_city: "",
    service_state: "",
    service_zip: "",
    created_at: "2026-03-01T00:00:00.000Z",
  };
}

function bill(siteId: string, id: string, meterId: string, r2Key: string | null): Record<string, string | null> {
  return {
    id,
    site_id: siteId,
    meter_id: meterId,
    r2_key: r2Key,
    status: "ok",
    notes: "",
    text_excerpt: "",
    billing_period_start: "2025-01-01",
    billing_period_end: "2025-01-31",
    source_file: "bill.pdf",
  };
}

const SITE_R2_SQL =
  "SELECT DISTINCT r2_key FROM bills WHERE site_id = ? AND r2_key IS NOT NULL AND r2_key <> ''";

interface World {
  env: Env;
  deleted: string[][];
  objects: { key: string }[];
}

function world(): World {
  const sites = [probe, keep];
  const meters = [meter(probe.id, "m-1"), meter(probe.id, "m-2"), meter(keep.id, "m-keep")];
  const bills = [
    bill(probe.id, "b1", "m-1", "sites/probe/2026-01/shared.pdf"),
    bill(probe.id, "b2", "m-2", "sites/probe/2026-01/shared.pdf"),
    bill(probe.id, "b3", "m-1", "legacy/probe/old.pdf"),
    bill(probe.id, "b4", "m-1", ""),
    bill(probe.id, "b5", "m-1", null),
    bill(keep.id, "b6", "m-keep", "sites/keep/keep.pdf"),
  ];
  const objects = [
    { key: "sites/probe/2026-01/shared.pdf" },
    { key: "sites/probe/2026-01/orphan.pdf" },
    { key: "legacy/probe/old.pdf" },
    { key: "sites/keep/keep.pdf" },
    { key: "sites/probe-extra/nope.pdf" },
  ];
  const deleted: string[][] = [];
  const bucket = {
    async list(options?: { prefix?: string; cursor?: string }) {
      const prefix = options?.prefix ?? "";
      const matched = objects.filter((object) => object.key.startsWith(prefix));
      const start = options?.cursor ? Number(options.cursor) : 0;
      const page = matched.slice(start, start + 1);
      const next = start + page.length;
      const listed = page.map((object) => ({ key: object.key }));
      if (next < matched.length) {
        return { objects: listed, delimitedPrefixes: [], truncated: true as const, cursor: String(next) };
      }
      return { objects: listed, delimitedPrefixes: [], truncated: false as const };
    },
    async delete(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      deleted.push(list);
      for (const key of list) {
        const index = objects.findIndex((object) => object.key === key);
        if (index >= 0) objects.splice(index, 1);
      }
    },
  };

  const db = {
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
          if (sql === "DELETE FROM bills WHERE site_id = ?") {
            removeWhere(bills, (row) => row.site_id === params[0]);
            return { success: true, meta: {} };
          }
          if (sql === "DELETE FROM meters WHERE site_id = ?") {
            removeWhere(meters, (row) => row.site_id === params[0]);
            return { success: true, meta: {} };
          }
          if (sql === "DELETE FROM sites WHERE id = ?") {
            removeWhere(sites, (row) => row.id === params[0]);
            return { success: true, meta: {} };
          }
          throw new Error(`unexpected sql: ${sql}`);
        },
      };
      return statement;
    },
    async batch(statements: { run: () => Promise<unknown> }[]) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };

  return {
    deleted,
    objects,
    env: {
      DB: db as unknown as D1Database,
      BILLS: bucket as unknown as R2Bucket,
      ASSETS: {} as Fetcher,
      API_TOKEN: TOKEN,
    } as Env,
  };
}

function removeWhere<T>(rowsToFilter: T[], match: (row: T) => boolean): void {
  for (let index = rowsToFilter.length - 1; index >= 0; index -= 1) {
    const row = rowsToFilter[index];
    if (row !== undefined && match(row)) rowsToFilter.splice(index, 1);
  }
}

function rows(
  sql: string,
  params: unknown[],
  sites: SiteRow[],
  meters: MeterRow[],
  bills: Record<string, string | null>[],
): object[] {
  if (sql.startsWith("SELECT id, name, created_at, utility, address, city, state, zip, notes, customer_name FROM sites ORDER BY name")) {
    return [...sites].sort((a, b) => a.name.localeCompare(b.name));
  }
  if (sql.startsWith("SELECT id, name, created_at, utility, address, city, state, zip, notes, customer_name FROM sites WHERE id = ?")) {
    return sites.filter((row) => row.id === params[0]);
  }
  if (sql === SITE_R2_SQL) {
    const seen = new Set<string>();
    const keys: { r2_key: string }[] = [];
    for (const row of bills) {
      if (row.site_id !== params[0] || !row.r2_key || seen.has(row.r2_key)) continue;
      seen.add(row.r2_key);
      keys.push({ r2_key: row.r2_key });
    }
    return keys;
  }
  if (sql.startsWith("SELECT * FROM meters WHERE site_id = ?")) {
    return meters.filter((row) => row.site_id === params[0]).sort((a, b) => a.meter_id.localeCompare(b.meter_id));
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

function formPost(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  };
}

describe("HTML site delete", () => {
  it("asks for the site name on the home list and the site page", async () => {
    const fixture = world();
    const home = await app.request("/", {}, fixture.env);
    expect(home.status).toBe(200);
    const homeHtml = await home.text();
    expect(homeHtml).toContain('action="/sites/probe/delete"');
    expect(homeHtml).toContain('action="/sites/keep/delete"');
    expect(homeHtml).toContain("Type name");
    expect(homeHtml).toContain("Probe &lt;auth&gt; &amp; co");
    expect(homeHtml).not.toMatch(/name="confirm_name"[^>]*value=/);

    const page = await app.request("/sites/probe", {}, fixture.env);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('id="delete-site"');
    expect(html).toContain('action="/sites/probe/delete"');
    expect(html).toContain("Type <strong>Probe &lt;auth&gt; &amp; co</strong> to confirm");
    expect(html).not.toContain("/api/v1/sites/probe/delete");
    expect(html).not.toMatch(/name="confirm_name"[^>]*value=/);
  });

  it("keeps the site when the typed name does not match", async () => {
    const fixture = world();
    const res = await app.request("/sites/probe/delete", formPost({ confirm_name: "auth probe" }), fixture.env);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/sites/probe?notice=confirm");
    expect(fixture.deleted).toEqual([]);
    expect(fixture.objects.map((object) => object.key)).toContain("sites/probe/2026-01/shared.pdf");

    const page = await app.request("/sites/probe?notice=confirm", {}, fixture.env);
    expect(await page.text()).toContain("Type the site name exactly to delete it.");

    const listed = await app.request("/api/v1/sites", { headers: { Authorization: `Bearer ${TOKEN}` } }, fixture.env);
    const body = (await listed.json()) as { id: string }[];
    expect(body.map((site) => site.id).sort()).toEqual(["keep", "probe"]);
  });

  it("deletes the site, its meters and bills, and its stored PDFs", async () => {
    const fixture = world();
    const res = await app.request(
      "/sites/probe/delete",
      formPost({ confirm_name: "  Probe <auth> & co  " }),
      fixture.env,
    );
    expect(res.status).toBe(303);
    const location = res.headers.get("location");
    expect(location).toBe(`/?${new URLSearchParams({ notice: "deleted", name: probe.name }).toString()}`);

    const home = await app.request(location ?? "/", {}, fixture.env);
    const html = await home.text();
    expect(html).toContain("Deleted Probe &lt;auth&gt; &amp; co.");
    expect(html).toContain('action="/sites/keep/delete"');
    expect(html).not.toContain('action="/sites/probe/delete"');

    expect(fixture.deleted.flat().sort()).toEqual([
      "legacy/probe/old.pdf",
      "sites/probe/2026-01/orphan.pdf",
      "sites/probe/2026-01/shared.pdf",
    ]);
    expect(fixture.objects.map((object) => object.key).sort()).toEqual([
      "sites/keep/keep.pdf",
      "sites/probe-extra/nope.pdf",
    ]);

    const gone = await app.request("/sites/probe", {}, fixture.env);
    expect(gone.status).toBe(404);

    const listed = await app.request("/api/v1/sites", { headers: { Authorization: `Bearer ${TOKEN}` } }, fixture.env);
    const body = (await listed.json()) as { id: string; meters: { meter_id: string }[] }[];
    expect(body).toEqual([
      expect.objectContaining({
        id: "keep",
        name: "Keep me",
        meters: [expect.objectContaining({ meter_id: "m-keep" })],
      }),
    ]);
  });

  it("does not expose delete on /api/v1", async () => {
    const fixture = world();
    const denied = await app.request(`/api/v1/sites/${probe.id}`, { method: "DELETE" }, fixture.env);
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "unauthorized" });

    const missing = await app.request(
      `/api/v1/sites/${probe.id}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${TOKEN}` } },
      fixture.env,
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });

    const posted = await app.request(
      `/api/v1/sites/${probe.id}/delete`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ confirm_name: probe.name }),
      },
      fixture.env,
    );
    expect(posted.status).toBe(404);
    expect(await posted.json()).toEqual({ error: "not_found" });

    const listed = await app.request("/api/v1/sites/probe", { headers: { Authorization: `Bearer ${TOKEN}` } }, fixture.env);
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { bill_counts: { total: number }; meters: unknown[] };
    expect(body.meters).toHaveLength(2);
    expect(body.bill_counts.total).toBe(5);
    expect(fixture.deleted).toEqual([]);
  });

  it("returns 404 for an unknown site and does not require a token", async () => {
    const fixture = world();
    const missing = await app.request("/sites/missing-site/delete", formPost({ confirm_name: "Missing" }), fixture.env);
    expect(missing.status).toBe(404);
    const badId = await app.request("/sites/bad%20id/delete", formPost({ confirm_name: "Bad" }), fixture.env);
    expect(badId.status).toBe(404);
    expect(fixture.deleted).toEqual([]);
  });
});
