interface Env {
  /** Worker secret. Set with `npx wrangler secret put API_TOKEN`. Never commit a value. */
  API_TOKEN?: string;
  /** Comma-separated browser origins. Unset uses the default allowlist in src/api.ts. */
  CORS_ORIGINS?: string;
}
