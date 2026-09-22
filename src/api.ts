import type { Context, Hono, MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import {
  createSite,
  findSiteIdByName,
  getSite,
  listBills,
  listMeters,
  listSites,
  type BillRow,
  type MeterRow,
  type SiteInput,
  type SiteRow,
} from "./db";
import { billExportRecords, csvResponse, fileSlug } from "./export";
import { isId, isMeterId } from "./ids";
import { ingestPdf, type IngestResult } from "./ingest";

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
const ALLOW_METHODS = ["GET", "POST", "OPTIONS"];
const NAME_MAX = 200;
const SHORT_MAX = 200;
const LONG_MAX = 2000;
const MAX_UPLOAD_FILES = 25;
const PROFILE_FIELDS = ["utility", "address", "city", "state", "zip", "notes", "customer_name"] as const;
const INGEST_COUNT_KEYS = ["ok", "needs_parser", "needs_password", "failed", "rejected"] as const;

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

export function mountApi(app: Hono<{ Bindings: Env }>): void {
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

  app.post("/api/v1/sites", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_body" }, 400);
    }
    const parsed = readCreateSite(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    if (await findSiteIdByName(c.env.DB, parsed.name)) {
      return c.json({ error: "name_taken" }, 409);
    }
    try {
      const site = await createSite(c.env.DB, parsed.name, parsed.profile);
      return c.json({ ...siteJson(site), meters: [] }, 201);
    } catch (error) {
      if (isSiteNameTaken(error)) return c.json({ error: "name_taken" }, 409);
      throw error;
    }
  });

  app.get("/api/v1/sites/:siteId", async (c) => {
    const loaded = await loadSite(c, c.req.param("siteId"));
    if (!loaded.ok) return loaded.response;
    const [meters, bills] = await Promise.all([
      listMeters(c.env.DB, loaded.site.id),
      listBills(c.env.DB, loaded.site.id),
    ]);
    return c.json({
      ...siteJson(loaded.site),
      meters: meters.map(meterJson),
      bill_counts: billCounts(bills),
    });
  });

  app.post("/api/v1/sites/:siteId/bills", async (c) => {
    const siteId = c.req.param("siteId");
    const loaded = await loadSite(c, siteId);
    if (!loaded.ok) return loaded.response;
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: "invalid_body" }, 400);
    }
    const files = pdfFiles(form);
    if (files.length === 0) return c.json({ error: "no_files" }, 400);
    const password = pdfPassword(form);
    const results: IngestResult[] = [];
    for (const file of files.slice(0, MAX_UPLOAD_FILES)) {
      results.push(...(await ingestPdf(c.env, siteId, file, { password })));
    }
    for (const file of files.slice(MAX_UPLOAD_FILES)) {
      results.push({
        sourceFile: file.name || "bill.pdf",
        meterId: "",
        status: "rejected",
        detail: "limit 25 files",
      });
    }
    const meters = await listMeters(c.env.DB, siteId);
    return c.json({
      site_id: siteId,
      results: results.map(resultJson),
      counts: ingestCounts(results),
      meters: meters.map(meterJson),
    });
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
      allowMethods: ALLOW_METHODS,
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

function siteJson(site: SiteRow): SiteRow {
  return {
    id: site.id,
    name: site.name,
    created_at: site.created_at,
    utility: site.utility,
    address: site.address,
    city: site.city,
    state: site.state,
    zip: site.zip,
    notes: site.notes,
    customer_name: site.customer_name,
  };
}

type LoadedSite =
  | { ok: true; site: SiteRow }
  | { ok: false; response: Response };

async function loadSite(c: Context<{ Bindings: Env }>, siteId: string): Promise<LoadedSite> {
  if (!isId(siteId)) return { ok: false, response: c.json({ error: "not_found" }, 404) };
  const site = await getSite(c.env.DB, siteId);
  if (!site) return { ok: false, response: c.json({ error: "not_found" }, 404) };
  return { ok: true, site };
}

function readCreateSite(
  body: unknown,
): { ok: true; name: string; profile: SiteInput } | { ok: false; error: "invalid_body" | "invalid_name" | "invalid_field" } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "invalid_body" };
  const record = body as Record<string, unknown>;
  if (typeof record.name !== "string") return { ok: false, error: "invalid_name" };
  const name = record.name.trim();
  if (!name || name.length > NAME_MAX) return { ok: false, error: "invalid_name" };
  const profile: SiteInput = {};
  for (const field of PROFILE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field) || record[field] == null) continue;
    const value = record[field];
    if (typeof value !== "string") return { ok: false, error: "invalid_field" };
    const trimmed = value.trim();
    const max = field === "address" || field === "notes" ? LONG_MAX : SHORT_MAX;
    if (trimmed.length > max) return { ok: false, error: "invalid_field" };
    profile[field] = trimmed;
  }
  return { ok: true, name, profile };
}

function isSiteNameTaken(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: sites\.name/i.test(error.message);
}

function billCounts(bills: Pick<BillRow, "status" | "notes">[]): {
  ok: number;
  needs_parser: number;
  needs_password: number;
  failed: number;
  total: number;
} {
  const counts = { ok: 0, needs_parser: 0, needs_password: 0, failed: 0, total: bills.length };
  for (const bill of bills) {
    if (bill.notes.startsWith("needs_password")) {
      counts.needs_password += 1;
      continue;
    }
    if (bill.status === "ok" || bill.status === "needs_parser" || bill.status === "failed") {
      counts[bill.status] += 1;
    }
  }
  return counts;
}

function pdfFiles(form: FormData): File[] {
  const files: File[] = [];
  for (const field of ["pdfs", "pdf"]) {
    for (const entry of form.getAll(field)) {
      if (entry instanceof File && entry.size > 0) files.push(entry);
    }
  }
  return files;
}

function pdfPassword(form: FormData): string | undefined {
  const value = form.get("pdf_password");
  if (typeof value !== "string") return undefined;
  const password = value.trim();
  return password || undefined;
}

function resultJson(result: IngestResult): {
  source_file: string;
  meter_id: string;
  status: IngestResult["status"];
  detail?: string;
} {
  const body: {
    source_file: string;
    meter_id: string;
    status: IngestResult["status"];
    detail?: string;
  } = {
    source_file: result.sourceFile,
    meter_id: result.meterId,
    status: result.status,
  };
  if (result.detail) body.detail = result.detail;
  return body;
}

function ingestCounts(results: IngestResult[]): Record<(typeof INGEST_COUNT_KEYS)[number], number> {
  const counts = { ok: 0, needs_parser: 0, needs_password: 0, failed: 0, rejected: 0 };
  for (const result of results) counts[result.status] += 1;
  return counts;
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
