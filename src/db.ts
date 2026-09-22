import { BILL_COLUMNS, type BillDraft, type BillStatus } from "./parsers/base";

export interface SiteRow {
  id: string;
  name: string;
  created_at: string;
  utility: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  notes: string;
  customer_name: string;
}

/** Optional fields accepted by POST /api/v1/sites. Blank when omitted. */
export interface SiteInput {
  utility?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  notes?: string;
  customer_name?: string;
}

const SITE_COLUMNS = "id, name, created_at, utility, address, city, state, zip, notes, customer_name";

export interface MeterRow {
  id: string;
  site_id: string;
  meter_id: string;
  utility: string;
  customer_name: string;
  customer_account: string;
  service_account: string;
  pod_id: string;
  service_address: string;
  service_city: string;
  service_state: string;
  service_zip: string;
  created_at: string;
}

export interface BillRow extends BillDraft {
  id: string;
  site_id: string;
  r2_key: string | null;
  created_at: string;
  updated_at: string;
  status: BillStatus;
  source_key: string;
  text_excerpt: string;
}

export function sourceKeyFor(siteId: string, fields: BillDraft, contentHash: string, index = 0): string {
  if (fields.meter_id && fields.billing_period_start && fields.billing_period_end) {
    return `${siteId}|${fields.meter_id}|${fields.billing_period_start}|${fields.billing_period_end}`;
  }
  return index === 0 ? `${siteId}|file|${contentHash}` : `${siteId}|file|${contentHash}|${index}`;
}

export async function listSites(db: D1Database): Promise<SiteRow[]> {
  const result = await db.prepare(`SELECT ${SITE_COLUMNS} FROM sites ORDER BY name`).all<SiteRow>();
  return result.results;
}

export async function getSite(db: D1Database, id: string): Promise<SiteRow | null> {
  return db.prepare(`SELECT ${SITE_COLUMNS} FROM sites WHERE id = ?`).bind(id).first<SiteRow>();
}

export async function findSiteIdByName(db: D1Database, name: string): Promise<string | null> {
  const row = await db.prepare("SELECT id FROM sites WHERE name = ?").bind(name).first<{ id: string }>();
  return row?.id ?? null;
}

export async function createSite(db: D1Database, name: string, input: SiteInput = {}): Promise<SiteRow> {
  const row: SiteRow = {
    id: crypto.randomUUID(),
    name,
    created_at: new Date().toISOString(),
    utility: input.utility ?? "",
    address: input.address ?? "",
    city: input.city ?? "",
    state: input.state ?? "",
    zip: input.zip ?? "",
    notes: input.notes ?? "",
    customer_name: input.customer_name ?? "",
  };
  await db
    .prepare(
      `INSERT INTO sites (${SITE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.name,
      row.created_at,
      row.utility,
      row.address,
      row.city,
      row.state,
      row.zip,
      row.notes,
      row.customer_name,
    )
    .run();
  return row;
}

export async function listMeters(db: D1Database, siteId: string): Promise<MeterRow[]> {
  const result = await db
    .prepare("SELECT * FROM meters WHERE site_id = ? ORDER BY meter_id")
    .bind(siteId)
    .all<MeterRow>();
  return result.results;
}

export async function listBills(db: D1Database, siteId: string, meterId?: string): Promise<BillRow[]> {
  const statement = meterId
    ? db
        .prepare(
          "SELECT * FROM bills WHERE site_id = ? AND meter_id = ? ORDER BY billing_period_start, source_file",
        )
        .bind(siteId, meterId)
    : db
        .prepare("SELECT * FROM bills WHERE site_id = ? ORDER BY meter_id, billing_period_start, source_file")
        .bind(siteId);
  const result = await statement.all<BillRow>();
  return result.results;
}

export async function listBillKeys(db: D1Database): Promise<
  Pick<BillRow, "site_id" | "meter_id" | "billing_period_start" | "billing_period_end">[]
> {
  const result = await db
    .prepare("SELECT site_id, meter_id, billing_period_start, billing_period_end FROM bills")
    .all<Pick<BillRow, "site_id" | "meter_id" | "billing_period_start" | "billing_period_end">>();
  return result.results;
}

export async function listMeterKeys(db: D1Database): Promise<Pick<MeterRow, "site_id" | "meter_id">[]> {
  const result = await db.prepare("SELECT site_id, meter_id FROM meters").all<Pick<MeterRow, "site_id" | "meter_id">>();
  return result.results;
}

export async function ensureMeter(db: D1Database, siteId: string, fields: BillDraft): Promise<void> {
  if (!fields.meter_id) return;
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO meters (
        id, site_id, meter_id, utility, customer_name, customer_account, service_account, pod_id,
        service_address, service_city, service_state, service_zip, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(site_id, meter_id) DO UPDATE SET
        utility = CASE WHEN excluded.utility <> '' THEN excluded.utility ELSE meters.utility END,
        customer_name = CASE WHEN excluded.customer_name <> '' THEN excluded.customer_name ELSE meters.customer_name END,
        customer_account = CASE WHEN excluded.customer_account <> '' THEN excluded.customer_account ELSE meters.customer_account END,
        service_account = CASE WHEN excluded.service_account <> '' THEN excluded.service_account ELSE meters.service_account END,
        pod_id = CASE WHEN excluded.pod_id <> '' THEN excluded.pod_id ELSE meters.pod_id END,
        service_address = CASE WHEN excluded.service_address <> '' THEN excluded.service_address ELSE meters.service_address END,
        service_city = CASE WHEN excluded.service_city <> '' THEN excluded.service_city ELSE meters.service_city END,
        service_state = CASE WHEN excluded.service_state <> '' THEN excluded.service_state ELSE meters.service_state END,
        service_zip = CASE WHEN excluded.service_zip <> '' THEN excluded.service_zip ELSE meters.service_zip END`,
    )
    .bind(
      crypto.randomUUID(),
      siteId,
      fields.meter_id,
      fields.utility,
      fields.customer_name,
      fields.customer_account,
      fields.service_account,
      fields.pod_id,
      fields.service_address,
      fields.service_city,
      fields.service_state,
      fields.service_zip,
      now,
    )
    .run();
}

export async function saveBill(
  db: D1Database,
  input: {
    siteId: string;
    fields: BillDraft;
    status: BillStatus;
    r2Key: string | null;
    contentHash: string;
    textExcerpt: string;
    rowIndex?: number;
    existingId?: string;
  },
): Promise<{ id: string; action: "inserted" | "updated" }> {
  const sourceKey = sourceKeyFor(input.siteId, input.fields, input.contentHash, input.rowIndex ?? 0);
  const now = new Date().toISOString();
  const byKey = await db
    .prepare("SELECT id FROM bills WHERE source_key = ?")
    .bind(sourceKey)
    .first<{ id: string }>();
  const existing = input.existingId
    ? await db.prepare("SELECT id, r2_key FROM bills WHERE id = ?").bind(input.existingId).first<{ id: string; r2_key: string | null }>()
    : null;

  if (byKey && existing && byKey.id !== existing.id) {
    await updateBill(db, byKey.id, input, sourceKey, now, input.r2Key ?? existing.r2_key);
    await db.prepare("DELETE FROM bills WHERE id = ?").bind(existing.id).run();
    return { id: byKey.id, action: "updated" };
  }

  const targetId = byKey?.id ?? existing?.id;
  if (targetId) {
    const keptR2 = input.r2Key ?? existing?.r2_key ?? null;
    await updateBill(db, targetId, input, sourceKey, now, keptR2);
    return { id: targetId, action: "updated" };
  }

  const id = crypto.randomUUID();
  const columns = [
    "id",
    "site_id",
    "r2_key",
    "created_at",
    "updated_at",
    "status",
    "source_key",
    "text_excerpt",
    ...BILL_COLUMNS,
  ];
  const values = [
    id,
    input.siteId,
    input.r2Key,
    now,
    now,
    input.status,
    sourceKey,
    input.textExcerpt,
    ...BILL_COLUMNS.map((column) => input.fields[column]),
  ];
  await db
    .prepare(`INSERT INTO bills (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .bind(...values)
    .run();
  return { id, action: "inserted" };
}

export async function deleteOtherR2Bills(
  db: D1Database,
  siteId: string,
  r2Key: string,
  keepIds: readonly string[],
): Promise<void> {
  const existing = await db
    .prepare("SELECT id FROM bills WHERE site_id = ? AND r2_key = ?")
    .bind(siteId, r2Key)
    .all<{ id: string }>();
  for (const row of existing.results) {
    if (!keepIds.includes(row.id)) {
      await db.prepare("DELETE FROM bills WHERE id = ?").bind(row.id).run();
    }
  }
}

async function updateBill(
  db: D1Database,
  id: string,
  input: { fields: BillDraft; status: BillStatus; textExcerpt: string },
  sourceKey: string,
  now: string,
  r2Key: string | null,
): Promise<void> {
  const assignments = [
    "r2_key = ?",
    "updated_at = ?",
    "status = ?",
    "source_key = ?",
    "text_excerpt = ?",
    ...BILL_COLUMNS.map((column) => `${column} = ?`),
  ];
  await db
    .prepare(`UPDATE bills SET ${assignments.join(", ")} WHERE id = ?`)
    .bind(
      r2Key,
      now,
      input.status,
      sourceKey,
      input.textExcerpt,
      ...BILL_COLUMNS.map((column) => input.fields[column]),
      id,
    )
    .run();
}
