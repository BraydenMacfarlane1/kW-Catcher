import {
  emptyBill,
  excerpt,
  missingRequired,
  type BillDraft,
  type BillParser,
  type BillStatus,
  type ParseOutcome,
} from "./base";
import { sceParser } from "./sce";

const PARSERS: readonly BillParser[] = [sceParser];

export function parsers(): readonly BillParser[] {
  return PARSERS;
}

export function parseDocument(text: string, sourceFile: string): ParseOutcome {
  const parser = PARSERS.find((candidate) => candidate.match(text));
  const textExcerpt = excerpt(text);
  if (!parser) {
    return {
      rows: [{ status: "needs_parser", fields: emptyBill(sourceFile) }],
      textExcerpt,
    };
  }
  try {
    const parsed = parser.parse(text, sourceFile);
    const rows = parsed.length > 0 ? parsed : [noMeterRow(sourceFile, parser.id)];
    return {
      rows: rows.map((fields) => ({ status: rowStatus(fields), fields })),
      textExcerpt,
    };
  } catch (error) {
    const fields = emptyBill(sourceFile);
    fields.parser_id = parser.id;
    fields.parse_confidence = "0.00";
    fields.notes = `exception:${error instanceof Error ? error.message : String(error)}`;
    return {
      rows: [{ status: "failed", fields }],
      textExcerpt,
    };
  }
}

function rowStatus(fields: BillDraft): BillStatus {
  return missingRequired(fields).length > 0 ? "failed" : "ok";
}

function noMeterRow(sourceFile: string, parserId: string): BillDraft {
  const fields = emptyBill(sourceFile);
  fields.parser_id = parserId;
  fields.parse_confidence = "0.00";
  fields.notes = "parser returned no meter rows";
  return fields;
}
