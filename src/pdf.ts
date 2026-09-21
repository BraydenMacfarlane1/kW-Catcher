import { extractText, getDocumentProxy } from "unpdf";

/** pdf.js PasswordResponses: 1 = password required, 2 = password rejected. */
const NEED_PASSWORD = 1;
const INCORRECT_PASSWORD = 2;

export class PdfPasswordError extends Error {
  readonly reason: "missing" | "incorrect";

  constructor(reason: "missing" | "incorrect") {
    super(
      reason === "missing"
        ? "needs_password: PDF is password-protected"
        : "needs_password: incorrect PDF password",
    );
    this.name = "PdfPasswordError";
    this.reason = reason;
  }
}

export async function extractPdfText(data: Uint8Array, password?: string): Promise<string> {
  // pdf.js transfers the buffer into its worker. Copy so the caller can still store the original bytes.
  const bytes = data.slice();
  const secret = password?.trim() ?? "";
  try {
    const pdf = await getDocumentProxy(bytes, secret ? { password: secret } : undefined);
    const { text } = await extractText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join("\n") : text;
  } catch (error) {
    const code = passwordCode(error);
    if (code === INCORRECT_PASSWORD) throw new PdfPasswordError("incorrect");
    if (code === NEED_PASSWORD) throw new PdfPasswordError("missing");
    throw error;
  }
}

function passwordCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const name = "name" in error ? String(error.name) : "";
  if (name !== "PasswordException") return undefined;
  const code = "code" in error ? Number(error.code) : Number.NaN;
  return Number.isFinite(code) ? code : NEED_PASSWORD;
}
