import { emptyBill, excerpt, missingRequired, type BillParser, type ParseOutcome } from "./base";
import { sceParser } from "./sce";

const PARSERS: readonly BillParser[] = [sceParser];

export function parsers(): readonly BillParser[] {
  return PARSERS;
}

export function parseDocument(text: string, sourceFile: string): ParseOutcome {
  const parser = PARSERS.find((candidate) => candidate.match(text));
  if (!parser) {
    return {
      status: "needs_parser",
      fields: emptyBill(sourceFile),
      textExcerpt: excerpt(text),
    };
  }
  try {
    const fields = parser.parse(text, sourceFile);
    const missing = missingRequired(fields);
    return {
      status: missing.length > 0 ? "failed" : "ok",
      fields,
      textExcerpt: excerpt(text),
    };
  } catch (error) {
    const fields = emptyBill(sourceFile);
    fields.parser_id = parser.id;
    fields.parse_confidence = "0.00";
    fields.notes = `exception:${error instanceof Error ? error.message : String(error)}`;
    return {
      status: "failed",
      fields,
      textExcerpt: excerpt(text),
    };
  }
}
