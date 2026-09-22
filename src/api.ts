import type { Context, Hono, MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { getSite, listBills, listMeters, listSites, type BillRow, type MeterRow, type SiteRow } from "./db";
import { billExportRecords, csvResponse, fileSlug } from "./export";
import { isId, isMeterId } from "./ids";

/**
 * Browser origins allowed to call /api/* when CORS_ORIGINS is unset.
 * `*` matches any characters (Pages preview hosts such as https://abc.sun-daddy.pages.dev).
 * Override with the CORS_ORIGINS secret or var (comma-separated). Custom domains belong there.
 */
export const DEFAULT_CORS_ORIGINS = [
  "https://sun-daddy.pages.dev",
  "https://*.sun-daddy.pages.dev",
  "https://sundaddy.pages.dev",
  "https://*.sundaddy.pages.dev",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:8788",
  "http://127.0.0.1:8788",
] as const;

const ALLOW_HEADERS = ["Authorization", "X-API-Token", "Content-Type"];

export function parseCorsOrigins(configured: string | undefined): string[] {
  const raw = configured?.trim();
  if (!raw) return [...DEFAULT_CORS_ORIGINS];
  return raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}

export function originAllowed(origin: string, allowed: readonly string[]): boolean {
  for (const entry of allowed) {
    if (entry.includes("*")) {
      const pattern = `^${entry.split("*").map(escapeRegExp).join(".*")}$`;
      if (new RegExp(pattern).test(origin)) return true;
    } else if (entry === origin) {
      return true;
    }
  }
  return false;
}

/** Bearer token when Authorization is a Bearer scheme; otherwise X-API-Token. */
export function presentedToken(authorization: string | undefined, apiTokenHeader: string | undefined): string | null {
  if (authorization) {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
    if (match?.[1]) return match[1];
  }
  const header = apiTokenHeader?.trim();
  return header ? header : null;
}

export function tokensEqual(provided: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(provided);
  const right = encoder.encode(expected);
  const length = Math.max(left.length, right.length, 1);
  let diff = left.length === right.length ? 0 : 1;
  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}

export function mountReadApi(app: Hono<{ Bindings: Env }>): void {
  app.use("*", apiCors());
  app.use("*", requireApiToken);

  app.get("/api/v1/sites", async (c) => {
    const sites = await listSites(c.env.DB);
    const body = await Promise.all(
      sites.map(async (site) => ({
        ...siteJson(site),
        meters: (await listMeters(c.env.DB, site.id)).map(meterJson),
      })),
    );
    return c.json(body);
  });

  app.get("/api/v1/sites/:siteId/export.csv", async (c) => {
    const loaded = await loadExport(c, c.req.param("siteId"));
    if (!loaded.ok) return loaded.response;
    return csvResponse(loaded.bills, `${fileSlug(loaded.site.name)}_all-meters.csv`);
  });

  app.get("/api/v1/sites/:siteId/export.json", async (c) => {
    const loaded = await loadExport(c, c.req.param("siteId"));
    if (!loaded.ok) return loaded.response;
    return c.json(billExportRecords(loaded.bills));
  });

  app.get("/api/v1/sites/:siteId/meters/:meterId/export.csv", async (c) => {
    const loaded = await loadExport(c, c.req.param("siteId"), c.req.param("meterId"));
    if (!loaded.ok) return loaded.response;
    const filename = `${fileSlug(loaded.site.name)}_${fileSlug(c.req.param("meterId"))}.csv`;
    return csvResponse(loaded.bills, filename);
  });

  app.get("/api/v1/sites/:siteId/meters/:meterId/export.json", async (c) => {
    const loaded = await loadExport(c, c.req.param("siteId"), c.req.param("meterId"));
    if (!loaded.ok) return loaded.response;
    return c.json(billExportRecords(loaded.bills));
  });
}

function apiCors(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    if (!c.req.path.startsWith("/api/")) return next();
    const allowed = parseCorsOrigins(c.env.CORS_ORIGINS);
    return cors({
      origin: (origin) => (originAllowed(origin, allowed) ? origin : null),
      allowMethods: ["GET", "OPTIONS"],
      allowHeaders: ALLOW_HEADERS,
      exposeHeaders: ["Content-Disposition"],
      maxAge: 86_400,
    })(c, next);
  };
}

function requireApiToken(c: Context<{ Bindings: Env }>, next: () => Promise<void>): Promise<void | Response> {
  if (c.req.path !== "/api/v1" && !c.req.path.startsWith("/api/v1/")) return next();
  if (c.req.method === "OPTIONS") return next();
  const expected = c.env.API_TOKEN;
  const presented = presentedToken(c.req.header("Authorization"), c.req.header("X-API-Token"));
  if (!expected || !presented || !tokensEqual(presented, expected)) {
    c.header("cache-control", "no-store");
    return Promise.resolve(c.json({ error: "unauthorized" }, 401));
  }
  return next().then(() => {
    c.header("cache-control", "no-store");
  });
}

type LoadedBills =
  | { ok: true; site: SiteRow; bills: BillRow[] }
  | { ok: false; response: Response };

async function loadExport(c: Context<{ Bindings: Env }>, siteId: string, meterId?: string): Promise<LoadedBills> {
  if (!isId(siteId) || (meterId !== undefined && !isMeterId(meterId))) {
    return { ok: false, response: c.json({ error: "not_found" }, 404) };
  }
  const site = await getSite(c.env.DB, siteId);
  if (!site) return { ok: false, response: c.json({ error: "not_found" }, 404) };
  const bills = await listBills(c.env.DB, siteId, meterId);
  if (meterId !== undefined && bills.length === 0) {
    return { ok: false, response: c.json({ error: "not_found" }, 404) };
  }
  return { ok: true, site, bills };
}

function siteJson(site: SiteRow): Pick<SiteRow, "id" | "name" | "created_at"> {
  return { id: site.id, name: site.name, created_at: site.created_at };
}

function meterJson(meter: MeterRow): MeterRow {
  return {
    id: meter.id,
    site_id: meter.site_id,
    meter_id: meter.meter_id,
    utility: meter.utility,
    customer_name: meter.customer_name,
    customer_account: meter.customer_account,
    service_account: meter.service_account,
    pod_id: meter.pod_id,
    service_address: meter.service_address,
    service_city: meter.service_city,
    service_state: meter.service_state,
    service_zip: meter.service_zip,
    created_at: meter.created_at,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
