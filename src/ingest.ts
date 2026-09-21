import { deleteOtherR2Bills, ensureMeter, saveBill } from "./db";
import { extractPdfText, PdfPasswordError } from "./pdf";
import { emptyBill, type BillStatus } from "./parsers/base";
import { parseDocument } from "./parsers/registry";

const MAX_BYTES = 20 * 1024 * 1024;

export interface IngestResult {
  sourceFile: string;
  meterId: string;
  status: BillStatus | "rejected" | "needs_password";
  detail: string;
}

export interface IngestOptions {
  /** Keep this R2 object. Re-parse reads it and does not write a second copy. */
  existingR2Key?: string;
  /**
   * Unlock password for this PDF. Not stored. The original bytes stay in R2,
   * so a later re-parse has to be given the password again.
   */
  password?: string;
}

export async function ingestPdf(
  env: Env,
  siteId: string,
  file: File,
  options: IngestOptions = {},
): Promise<IngestResult[]> {
  const sourceFile = safeFileName(file.name || "bill.pdf");
  if (file.size <= 0) {
    return [{ sourceFile, meterId: "", status: "rejected", detail: "empty file" }];
  }
  if (file.size > MAX_BYTES) {
    return [{ sourceFile, meterId: "", status: "rejected", detail: "file is larger than 20 MB" }];
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isPdf(bytes, file.type)) {
    return [{ sourceFile, meterId: "", status: "rejected", detail: "not a PDF" }];
  }

  const contentHash = await sha256Hex(bytes);
  const existingR2Key = options.existingR2Key;
  const r2Key =
    existingR2Key ??
    `sites/${siteId}/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}-${sourceFile}`;

  if (!existingR2Key) {
    await env.BILLS.put(r2Key, bytes, {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: { site_id: siteId, source_file: sourceFile },
    });
  }

  let outcome = parseDocument("", sourceFile);
  try {
    const text = await extractPdfText(bytes, options.password);
    outcome = parseDocument(text, sourceFile);
  } catch (error) {
    if (error instanceof PdfPasswordError) {
      if (existingR2Key) {
        await env.DB.prepare(
          `UPDATE bills SET notes = ?, updated_at = ? WHERE site_id = ? AND r2_key = ? AND status <> 'ok'`,
        )
          .bind(error.message, new Date().toISOString(), siteId, existingR2Key)
          .run();
        return [{ sourceFile, meterId: "", status: "needs_password", detail: error.message }];
      }
      const fields = emptyBill(sourceFile);
      fields.notes = error.message;
      fields.parse_confidence = "0.00";
      outcome = {
        rows: [{ status: "failed", fields }],
        textExcerpt: "",
      };
    } else {
      const message = error instanceof Error ? error.message : String(error);
      if (existingR2Key) {
        return [{ sourceFile, meterId: "", status: "failed", detail: `extract failed; kept stored rows (${message})` }];
      }
      const fields = emptyBill(sourceFile);
      fields.notes = `extract:${message}`;
      fields.parse_confidence = "0.00";
      outcome = {
        rows: [{ status: "failed", fields }],
        textExcerpt: "",
      };
    }
  }

  const results: IngestResult[] = [];
  const keptIds: string[] = [];
  for (const [index, row] of outcome.rows.entries()) {
    await ensureMeter(env.DB, siteId, row.fields);
    const saved = await saveBill(env.DB, {
      siteId,
      fields: row.fields,
      status: row.status,
      r2Key,
      contentHash,
      textExcerpt: outcome.textExcerpt,
      rowIndex: index,
    });
    keptIds.push(saved.id);
    const status = row.fields.notes.startsWith("needs_password") ? "needs_password" : row.status;
    results.push({
      sourceFile,
      meterId: row.fields.meter_id,
      status,
      detail: `${saved.action} ${status}${row.fields.meter_id ? ` meter ${row.fields.meter_id}` : ""}`,
    });
  }
  await deleteOtherR2Bills(env.DB, siteId, r2Key, keptIds);
  return results;
}

export async function reparseStoredBills(env: Env, siteId: string, password?: string): Promise<IngestResult[]> {
  const stored = await env.DB.prepare(
    `SELECT r2_key, MIN(source_file) AS source_file
     FROM bills
     WHERE site_id = ? AND r2_key IS NOT NULL AND r2_key <> ''
     GROUP BY r2_key`,
  )
    .bind(siteId)
    .all<{ r2_key: string; source_file: string }>();

  const results: IngestResult[] = [];
  for (const bill of stored.results) {
    const object = await env.BILLS.get(bill.r2_key);
    if (!object) {
      results.push({
        sourceFile: bill.source_file || bill.r2_key,
        meterId: "",
        status: "failed",
        detail: "missing R2 object",
      });
      continue;
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    const file = new File([bytes], bill.source_file || "bill.pdf", { type: "application/pdf" });
    const parsed = await ingestPdf(env, siteId, file, { existingR2Key: bill.r2_key, password });
    results.push(...parsed);
  }
  return results;
}

function isPdf(bytes: Uint8Array, mime: string): boolean {
  if (mime === "application/pdf" || mime === "application/x-pdf") return true;
  return bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

function safeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "bill.pdf";
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+/, "");
  return cleaned || "bill.pdf";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
