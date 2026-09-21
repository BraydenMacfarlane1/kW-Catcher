import { ensureMeter, saveBill } from "./db";
import { extractPdfText } from "./pdf";
import { type BillStatus } from "./parsers/base";
import { parseDocument } from "./parsers/registry";

const MAX_BYTES = 20 * 1024 * 1024;

export interface IngestResult {
  sourceFile: string;
  status: BillStatus | "rejected";
  detail: string;
}

export async function ingestPdf(
  env: Env,
  siteId: string,
  file: File,
  existingId?: string,
): Promise<IngestResult> {
  const sourceFile = safeFileName(file.name || "bill.pdf");
  if (file.size <= 0) {
    return { sourceFile, status: "rejected", detail: "empty file" };
  }
  if (file.size > MAX_BYTES) {
    return { sourceFile, status: "rejected", detail: "file is larger than 20 MB" };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isPdf(bytes, file.type)) {
    return { sourceFile, status: "rejected", detail: "not a PDF" };
  }

  const contentHash = await sha256Hex(bytes);
  const r2Key = existingId
    ? null
    : `sites/${siteId}/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}-${sourceFile}`;

  if (r2Key) {
    await env.BILLS.put(r2Key, bytes, {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: { site_id: siteId, source_file: sourceFile },
    });
  }

  let text = "";
  let outcome = parseDocument("", sourceFile);
  try {
    text = await extractPdfText(bytes);
    outcome = parseDocument(text, sourceFile);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (existingId) {
      return { sourceFile, status: "failed", detail: `extract failed; kept stored row (${message})` };
    }
    outcome = {
      status: "failed",
      fields: outcome.fields,
      textExcerpt: "",
    };
    outcome.fields.notes = `extract:${message}`;
    outcome.fields.parse_confidence = "0.00";
    outcome.fields.source_file = sourceFile;
  }

  await ensureMeter(env.DB, siteId, outcome.fields);
  const action = await saveBill(env.DB, {
    siteId,
    fields: outcome.fields,
    status: outcome.status,
    r2Key,
    contentHash,
    textExcerpt: outcome.textExcerpt,
    existingId,
  });

  return {
    sourceFile,
    status: outcome.status,
    detail: `${action} ${outcome.status}`,
  };
}

export async function reparseStoredBills(env: Env, siteId: string): Promise<IngestResult[]> {
  const stored = await env.DB.prepare(
    "SELECT id, r2_key, source_file FROM bills WHERE site_id = ? AND r2_key IS NOT NULL AND r2_key <> ''",
  )
    .bind(siteId)
    .all<{ id: string; r2_key: string; source_file: string }>();

  const results: IngestResult[] = [];
  for (const bill of stored.results) {
    const object = await env.BILLS.get(bill.r2_key);
    if (!object) {
      results.push({ sourceFile: bill.source_file || bill.r2_key, status: "failed", detail: "missing R2 object" });
      continue;
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    const file = new File([bytes], bill.source_file || "bill.pdf", { type: "application/pdf" });
    results.push(await ingestPdf(env, siteId, file, bill.id));
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
