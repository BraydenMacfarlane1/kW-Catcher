# kW-Catcher

Track utility bills by site and meter. Upload PDFs, keep the files, extract what a parser knows, and export CSV. History stays in D1. There is no PDF report generator and no AI parser.

## Stack

- Cloudflare Workers with static assets (`public/`)
- [Hono](https://hono.dev/) + TypeScript
- D1 binding `DB`, database name `kw-catcher`
- R2 binding `BILLS`, bucket `kw-catcher-bills`
- PDF text via [`unpdf`](https://github.com/unjs/unpdf) on the Worker
- `compatibility_date` `2026-09-21`, which turns on `nodejs_compat` and `nodejs_compat_v2` (required by unpdf). Do not set `no_nodejs_compat`.

## Install

```bash
npm install
```

Node 22 or newer.

## Cloudflare resources

`wrangler.jsonc` is wired to the existing account resources:

| Binding | Resource | Name / id |
| --- | --- | --- |
| `DB` | D1 | database `kw-catcher`, id `0de9f52d-6073-45d9-b46c-ad7bf0a8c328` |
| `BILLS` | R2 | bucket `kw-catcher-bills` |

Log in, apply migrations to that database, then deploy:

```bash
npx wrangler login
npm run db:migrate:remote
npm run deploy
```

`npm run types` rewrites `worker-configuration.d.ts` after binding changes.

## Local dev

```bash
npm run db:migrate:local
npm run dev
```

Open http://localhost:8787. Migrations create the tables and load the seed site **XU Holdings — Irwindale** (meter `259000-081267`, 12 SCE bills from `seed/xu-holdings-sce-12mo.csv`).

Regenerate the seed migrations after editing that CSV:

```bash
npm run seed:sql
```

That writes `migrations/0002_seed_xu_holdings.sql` (the original bill columns, so it still applies on the table from `0001`) and `migrations/0004_charge_components.sql` (`taxes_usd`, `fees_usd`, `line_items_json`, plus the residual `other_charges_usd`). Apply new migrations locally with `npm run db:migrate:local`.

## Upload, gaps, CSV

1. Open a site and upload one or more PDFs.
2. Each file is stored in R2 as uploaded, text is extracted with unpdf, and the parser registry runs. Password-protected PDFs need the optional PDF password on the upload form. That one password is applied to every file in the submission. The password is not stored. R2 keeps the original bytes, including an encrypted PDF, so re-parse asks for the password again. A missing or wrong password saves a `failed` row whose notes start with `needs_password` and leaves bill amounts blank. The result banner counts that outcome as `needs_password`. Re-parse of an encrypted file without the password keeps the rows already stored.
3. Each meter on a PDF becomes its own bill row, and each billing period in a combined multi-statement PDF becomes its own bill row (the same result as uploading those months as separate PDFs). The row count is the number of statements in the file. That length is not fixed: two statements become two rows, and a full year or longer (12+ months) becomes one row per statement. Those rows share one R2 object (`r2_key`) and upsert on `(site_id, meter_id, billing_period_start, billing_period_end)`. kWh and demand are stored per meter and per period and are never added together. A file that does not identify a meter and period upserts on a hash source key.
4. The site page shows a separate table per `meter_id`. Missing months are computed for that meter only, between its own earliest and latest bill.
5. If no parser matches, one `needs_parser` row is saved: the PDF and a text excerpt are kept, and bill fields are left blank (`line_items_json` is `[]`).
6. **Download this meter** on each table, or `GET /sites/:id/meters/:meterId/export.csv`. **All meters CSV** (`GET /sites/:id/export.csv`) is the Sun Daddy ingest contract v1 columns, one row per meter, with no total row. `id`, `site_id`, `r2_key`, `created_at`, and `status` (`ok`, `needs_parser`, `failed`) are appended after the contract columns. The HTML pages and these two URLs stay unauthenticated.
7. **Re-parse stored PDFs** runs the registry once per stored file (not once per meter or period row).

## HTTP API

Sun Daddy creates sites, uploads bill PDFs, and pulls the same rows over JSON and CSV. Worker name in `wrangler.jsonc` is `kw-catcher`, which deploys to `https://kw-catcher.braydenm.workers.dev` (no custom domain in config). Column names are Sun Daddy ingest contract v1. JSON values are strings, the same cells as the CSV.

`GET /api/health` stays public. Every `/api/v1/*` route requires the Worker secret `API_TOKEN`. Send `Authorization: Bearer <token>` or `X-API-Token: <token>`. A missing secret, missing token, or wrong token is `401` with `{ "error": "unauthorized" }`. The token is not in the repo. The HTML pages and `POST /sites` / `POST /sites/:id/upload` stay unauthenticated.

| Method | Path | Auth | Body |
| --- | --- | --- | --- |
| `GET` | `/api/health` | public | `{ "ok": true }` |
| `GET` | `/api/v1/sites` | token | JSON array of sites, each with nested `meters` |
| `POST` | `/api/v1/sites` | token | Create a site. JSON body. `201` `{ id, name, created_at, utility, address, city, state, zip, notes, customer_name, meters: [] }` |
| `GET` | `/api/v1/sites/:siteId` | token | One site, `meters`, and `bill_counts` |
| `POST` | `/api/v1/sites/:siteId/bills` | token | `multipart/form-data` PDF upload. JSON results, not a redirect |
| `GET` | `/api/v1/sites/:siteId/export.csv` | token | All meters on the site. Same file as the UI all-meters CSV |
| `GET` | `/api/v1/sites/:siteId/export.json` | token | JSON array of those rows |
| `GET` | `/api/v1/sites/:siteId/meters/:meterId/export.csv` | token | One meter. Same file as **Download this meter** |
| `GET` | `/api/v1/sites/:siteId/meters/:meterId/export.json` | token | JSON array of that meter's rows |
| `OPTIONS` | `/api/v1/*` and `/api/health` | public | CORS preflight. No token |

A meter export with no rows is `404` `{ "error": "not_found" }`, matching the UI. A site export with no rows is `200` and an empty CSV (header only) or `[]`. An unknown site id on the write routes is the same `404`.

### Create a site and upload bills

`POST /api/v1/sites` reads a JSON object. `name` is required (trimmed, 1–200 characters). Optional strings: `utility`, `address`, `city`, `state`, `zip`, `notes`, `customer_name`. Unknown fields are ignored. Those optional fields are stored on `sites` by `migrations/0005_site_profile.sql` and returned on list, create, and get. Existing rows stay blank. A duplicate name is `409` `{ "error": "name_taken" }`. A missing or too-long name, a non-string profile field, or a non-JSON body is `400`.

`GET /api/v1/sites/:siteId` is the poll response: the site, its meters, and `bill_counts` of `{ ok, needs_parser, needs_password, failed, total }`. `needs_password` counts stored rows whose `notes` start with `needs_password` (the row's `status` is `failed`). Those rows are not also counted in `failed`. `total` is every bill row on the site.

`POST /api/v1/sites/:siteId/bills` accepts `multipart/form-data`. File fields are `pdfs` (repeat for several files) and `pdf` (one file). Both are ingested, `pdfs` first. Optional `pdf_password` is the same one password the HTML form applies to every file in the submission. It is not stored. At most 25 files are parsed; the rest are `rejected` with detail `limit 25 files`. Each file goes through `ingestPdf`, the same function as `POST /sites/:id/upload`. The response is `200` JSON:

```json
{
  "site_id": "...",
  "results": [{ "source_file": "bill1.pdf", "meter_id": "...", "status": "ok", "detail": "..." }],
  "counts": { "ok": 1, "needs_parser": 0, "needs_password": 0, "failed": 0, "rejected": 0 },
  "meters": []
}
```

`status` is `ok`, `needs_parser`, `needs_password`, `failed`, or `rejected`. `detail` is omitted when empty. A request with no file is `400` `{ "error": "no_files" }`.

Sun Daddy flow: create a site (optional when the site already exists) → upload PDFs → poll `GET /api/v1/sites/:siteId` → `GET /api/v1/sites/:siteId/export.json`.

```bash
curl -X POST "$BASE/api/v1/sites" -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" -d '{"name":"Acme Warehouse"}'
curl -X POST "$BASE/api/v1/sites/$SITE_ID/bills" -H "Authorization: Bearer $API_TOKEN" -F "pdfs=@bill1.pdf" -F "pdfs=@bill2.pdf"
curl "$BASE/api/v1/sites/$SITE_ID" -H "Authorization: Bearer $API_TOKEN"
```

### Secret and deploy

Generate a token locally and store it only as a Worker secret (and in Sun Daddy's server config). `.dev.vars` is gitignored and is what `wrangler dev` reads. `wrangler secret put` prompts for the value; it is not written to the repo. This change does not add a new secret. It does add `migrations/0005_site_profile.sql`. Apply that migration before deploying the worker that selects and inserts the new site columns. Until it runs, list and create fail with a missing-column error.

```bash
openssl rand -base64 32
npx wrangler secret put API_TOKEN
npm run db:migrate:remote
npm run deploy
```

Skip `wrangler secret put` when `API_TOKEN` is already set on the Worker. Local dev:

```bash
npm run db:migrate:local
printf 'API_TOKEN=%s\n' 'paste-the-token' > .dev.vars
npm run dev
```

### Examples

```bash
export API_TOKEN='paste-the-token'
BASE=https://kw-catcher.braydenm.workers.dev

curl -X POST "$BASE/api/v1/sites" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Acme Warehouse"}'

curl -X POST "$BASE/api/v1/sites/$SITE_ID/bills" \
  -H "Authorization: Bearer $API_TOKEN" \
  -F "pdfs=@bill1.pdf" -F "pdfs=@bill2.pdf"

curl "$BASE/api/v1/sites/$SITE_ID" -H "Authorization: Bearer $API_TOKEN"

curl -sS "$BASE/api/v1/sites" -H "Authorization: Bearer $API_TOKEN"

curl -sS "$BASE/api/v1/sites/$SITE_ID/meters/$METER_ID/export.csv" \
  -H "Authorization: Bearer $API_TOKEN" -o meter.csv

curl -sS "$BASE/api/v1/sites/$SITE_ID/meters/$METER_ID/export.json" \
  -H "Authorization: Bearer $API_TOKEN"

curl -sS "$BASE/api/v1/sites/$SITE_ID/export.json" -H "X-API-Token: $API_TOKEN"
```

### CORS

Browsers on Sun Daddy Pages can call `/api/*`. Allowed methods are `GET`, `POST`, and `OPTIONS`. Allowed request headers are `Authorization`, `X-API-Token`, and `Content-Type`. When `CORS_ORIGINS` is unset, the allowlist is:

- `https://sun-daddy.pages.dev` and `https://*.sun-daddy.pages.dev`
- `https://sundaddy.pages.dev` and `https://*.sundaddy.pages.dev`
- `http://localhost:5173`, `http://127.0.0.1:5173`, `http://localhost:8788`, `http://127.0.0.1:8788`

`*` is a glob (`https://preview.sun-daddy.pages.dev` matches the sun-daddy preview entry). Setting `CORS_ORIGINS` replaces that list. Use it for a custom domain:

```bash
printf '%s' 'https://app.example.com,https://sun-daddy.pages.dev,https://*.sun-daddy.pages.dev,http://localhost:5173' \
  | npx wrangler secret put CORS_ORIGINS
npm run deploy
```

You can put the same comma-separated value in `wrangler.jsonc` under `"vars"` instead of a secret. Do not put `API_TOKEN` in `wrangler.jsonc`.

## Add a parser

Parsers live in `src/parsers/`. Each one implements `BillParser` from `src/parsers/base.ts`:

```ts
export interface BillParser {
  id: string;
  match(text: string): boolean;
  parse(text: string, sourceFile: string): BillDraft[];
}
```

1. Add `src/parsers/<utility>.ts`. `match` should be strict. `parse` returns one `BillDraft` per meter per billing period and only fills fields it actually found. Do not sum meters or periods into one row. A combined PDF is split into statements first; each statement is parsed on its own.
2. Register it in the `PARSERS` array in `src/parsers/registry.ts`. The first match wins.
3. Add a fixture under `test/fixtures/` and a Vitest case. Do not guess amounts for an unknown layout; return what you can and let missing required fields mark the row `failed`.

`src/parsers/sce.ts` (`sce_tou_gs2_layout_v1`) is the Southern California Edison TOU-GS-2-E parser. It handles summer on/mid/off peak and winter mid/off/super-off peak, including transition bills that contain both. A PDF with several `For meter` lines and a Usage block per meter returns one row per meter. It was ported from the one-shot `extract_sce.py` extractor.

`src/parsers/nvenergy.ts` (`nv_energy_lgs1_layout_v1`) is the NV Energy parser. It matches `NV Energy`, `NVEnergy`, or `nvenergy.com`. It splits on each statement it finds (`PAGE 1 OF`, or each meter plus a KWH period) and returns one row per statement. N statements become N rows, including a full year and files longer than 12 months. The sample combined PDF happens to contain 11 statements; that count is not a parser limit. Those rows share the uploaded file. LGS-1 is not time-of-use: `kwh_on_peak`, `kwh_mid_peak`, `kwh_off_peak`, and `kwh_super_off_peak` stay blank, and all usage is `kwh_total`. `demand_kw_max` comes from a single `Demand Charge` kW line. A period that only has prior/new rate demand lines leaves `demand_kw_max` blank. Charge detail lines are stored in `line_items_json`. Electric consumption and deferred energy adjustment are energy, demand charge lines are demand, and the remaining lines (facility, programs, basic service, local government fee, universal energy charge) are fees. Single-month PDFs still parse as one row.

`src/parsers/rmp.ts` (`rocky_mountain_power_v1`) is the Rocky Mountain Power / PacifiCorp parser. It matches `Rocky Mountain Power`, `RockyMountainPower`, a short `Rocky Mtn Power` line from a scan, or `PacifiCorp`. It returns one row per kWh service-period line (each `SERVICE PERIOD` block). N statements become N rows. There is no fixed period count. The Schedule 23 sample happens to contain 12 periods (March 2025 through March 2026). The Schedule 6 sample is an 11-page scan, one bill image per page, and yields one row per page the OCR can read. Rate schedule comes from `Schedule 23`, `Ct Meter Schedule 6`, or any other `Schedule N` on that statement. These schedules are not time-of-use, so the TOU kWh and demand columns stay blank and usage is `kwh_total` from `AMOUNT USED`. `demand_kw_max` comes from the meter's `Demand … kw` line. Period cost is `New Charges`, stored as both `total_new_charges_usd` and `amount_due_usd`. On an Equal Payment Plan bill, `Amount Due` is the installment and is not used as the energy cost. A scanned page is its own statement: New Charges, dates, and demand come from that page, not from the previous page. When one account period has more than one kWh meter (for example Schedule 6 and Schedule 23), each meter is its own row. That row's dollars are the charge lines under that item. If the account `New Charges` total sits on the other meter's page, that meter keeps the total minus the itemized meters, so the rows add up to `New Charges` and the full account total is not copied onto every meter. A period with a single kWh meter still uses the statement `New Charges` total, including when an itemized subtotal is only part of that bill. `Current Account Balance` is not used, because it includes past due. `BILLING DATE` and `DUE DATE` (or `Date Due`) become `bill_prepared_date` and `due_date`. Charge lines under `NEW CHARGES` / detailed account activity go in `line_items_json`. Wrapped or unreadable lines stay out of the item list; `other_charges_usd` is the residual so the components still add up to `New Charges`.

Scanned PDFs whose text layer is empty are OCR'd before parsing. Each page is read in order, with no page cap. A Canon MRC scan that stores a sharp CCITT fax text mask over a low-resolution JPEG is read from that mask (pdf.js in the Worker build cannot decode those masks). Portrait pages whose text runs sideways are rotated a quarter turn before OCR; bilevel masks pick clockwise versus counterclockwise from the text, and a blurry photo probes both directions. Other scans still use the largest embedded page image, turned into grayscale. When the Workers AI binding is present, a page is transcribed with `@cf/meta/llama-3.2-11b-vision-instruct`. If that transcription is missing or does not look like a bill, the page falls back to in-process `tesseract.js-core` (LSTM, English, SIMD when the runtime allows it). That fallback runs inside the Worker isolate. tesseract.js's own worker thread is not used, because Workers cannot spawn it. Workers disallow compiling wasm bytes at runtime, so the SIMD core is imported as a precompiled module. `eng.traineddata` loads from disk when that file is readable and from jsDelivr otherwise. Node tests compile the wasm from `node_modules`. Neither artifact is stored in R2. Text-layer PDFs, including password-protected Rocky Mountain Power statements, still use unpdf and never call OCR. The password unlocks the file first; a missing or wrong password still returns `needs_password` and does not invent amounts. `npm test` has no AI binding, so it takes the tesseract.js-core path. `"ai": { "binding": "AI" }` is already in `wrangler.jsonc` so a deployed Worker prefers the vision model and keeps request CPU time off a multi-page WASM scan.

When a bill has a **Details of your new charges** section, each charge line is stored in `line_items_json` as `{label, amount_usd, category}` with category `tax`, `fee`, `energy`, `demand`, or `other`. `taxes_usd` sums lines the bill labels as tax (UUT, state tax). `fees_usd` sums fee-like labels (customer charge, franchise fees, wildfire fund, public purpose, fixed recovery, and similar). `other_charges_usd` is the residual, so energy + demand + taxes + fees + other equals `total_new_charges_usd` within rounding. The "your charges include" bullets restate dollars already inside the charge lines, so they stay out of `fees_usd` and `line_items_json`. Bills without that section leave `taxes_usd` and `fees_usd` blank, `line_items_json` as `[]`, and keep the summary other-charges amount, which still reconciles the same way.

## Tests and build

```bash
npm test
npm run check
npm run build
```

`npm test` checks the SCE parser against `seed/xu-holdings-sce-12mo.csv`, unpdf text, `pdftotext -layout` text, and `test/fixtures/bill0-original.pdf`, plus winter, transition, unknown-utility, and gap cases. It also checks the NV Energy parser against `test/fixtures/nv-energy-combined.pdf` and the `pdftotext -layout` text of that file. That sample contains 11 statements, so the test expects 11 rows. Concatenated slices of 2 and 3 statements expect 2 and 3 rows. The Rocky Mountain Power tests unlock `test/fixtures/rmp-combined.pdf` with the fixture password and expect 12 service periods from that file, plus 2 and 3 rows from concatenated statement text. A missing or wrong password fails with `needs_password` and does not invent amounts. The Schedule 6 scan is OCR'd from `test/fixtures/rmp-schedule6-scanned.pdf`; the test expects the January 2025 page (meter, kWh, demand, schedule, New Charges rather than the equal-payment installment) and does not assume every page of an 11-page scan will OCR. `test/fixtures/rmp-terra-sideways.pdf` is a half-letter portrait scan of landscape statements (Schedule 6 meter 348204388 and Schedule 23 meter 348204387). The test checks that odd pages rotate one way and even pages the other, and that OCR yields a row per meter per period, including the August 2025 window.

## Data model

- `sites` — a location. `id`, `name`, and `created_at`, plus optional profile columns from `migrations/0005_site_profile.sql`: `utility`, `address`, `city`, `state`, `zip`, `notes`, `customer_name`. The HTML create form still only sets `name`.
- `meters` — one utility meter on a site
- `bills` — one row per meter per billing period (or one row per unmatched file). Several rows may share `r2_key` when they came from the same PDF, whether that file has several meters or several billing periods. Totals are not rolled up across meters or periods.

## Sun Daddy ingest contract v1

CSV export, the D1 `bills` columns, the SCE parser, and `seed/xu-holdings-sce-12mo.csv` use this contract. Column names stay the kW-Catcher names; Sun Daddy maps them on ingest. Every export includes every column below. A cell is blank only when that value is absent on the bill.

Required: `billing_period_start`, `billing_period_end` (`YYYY-MM-DD`, not a month index), `kwh_total`, `demand_kw_max`, `kwh_on_peak`, `kwh_mid_peak`, `kwh_off_peak`, `kwh_super_off_peak`. A season with no on-peak or super-off-peak leaves that bucket blank. A bucket the bill does report is kept.

Strongly recommended: `meter_id`, `service_account`, `customer_account`, `utility`, `rate_schedule`, `service_address`, `service_city`, `service_state`, `service_zip`, `billing_days`, `parse_confidence`, `source_file`, `parser_id`.

Optional provenance: `energy_charges_usd`, `demand_charges_usd`, `taxes_usd`, `fees_usd`, `other_charges_usd` (residual), `total_new_charges_usd`, `amount_due_usd`, `due_date`, `bill_prepared_date`, `line_items_json`, `demand_kw_on_peak`, `demand_kw_mid_peak`, `demand_kw_off_peak`, `demand_kw_super_off_peak`, `notes`, `pod_id`, `rin`, `service_voltage`, `customer_name`.

`energy_charges_usd + demand_charges_usd + taxes_usd + fees_usd + other_charges_usd` matches `total_new_charges_usd` within rounding. Meters are never aggregated into one row.
