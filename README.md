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

Regenerate the seed migration after editing that CSV:

```bash
npm run seed:sql
```

Re-apply a changed seed file locally with:

```bash
npx wrangler d1 execute kw-catcher --local --file=./migrations/0002_seed_xu_holdings.sql
```

## Upload, gaps, CSV

1. Open a site and upload one or more PDFs.
2. Each file is stored in R2, text is extracted with unpdf, and the parser registry runs.
3. Each meter on a PDF becomes its own bill row. Those rows share one R2 object (`r2_key`) and upsert on `(site_id, meter_id, billing_period_start, billing_period_end)`. kWh and demand are stored per meter and are never added together. A file that does not identify a meter and period upserts on a hash source key.
4. The site page shows a separate table per `meter_id`. Missing months are computed for that meter only, between its own earliest and latest bill.
5. If no parser matches, one `needs_parser` row is saved: the PDF and a text excerpt are kept, and bill fields are left blank.
6. **Download this meter** on each table, or `GET /sites/:id/meters/:meterId/export.csv`. **All meters CSV** (`GET /sites/:id/export.csv`) is the same columns stacked one row per meter, still keyed by `meter_id`, with no total row. Columns are the bill fields plus `id`, `site_id`, `r2_key`, `created_at`, and `status` (`ok`, `needs_parser`, `failed`).
7. **Re-parse stored PDFs** runs the registry once per stored file (not once per meter row).

## Add a parser

Parsers live in `src/parsers/`. Each one implements `BillParser` from `src/parsers/base.ts`:

```ts
export interface BillParser {
  id: string;
  match(text: string): boolean;
  parse(text: string, sourceFile: string): BillDraft[];
}
```

1. Add `src/parsers/<utility>.ts`. `match` should be strict. `parse` returns one `BillDraft` per meter and only fills fields it actually found. Do not sum meters into one row.
2. Register it in the `PARSERS` array in `src/parsers/registry.ts`. The first match wins.
3. Add a fixture under `test/fixtures/` and a Vitest case. Do not guess amounts for an unknown layout; return what you can and let missing required fields mark the row `failed`.

`src/parsers/sce.ts` (`sce_tou_gs2_layout_v1`) is the Southern California Edison TOU-GS-2-E parser. It handles summer on/mid/off peak and winter mid/off/super-off peak, including transition bills that contain both. A PDF with several `For meter` lines and a Usage block per meter returns one row per meter. It was ported from the one-shot `extract_sce.py` extractor.

## Tests and build

```bash
npm test
npm run check
npm run build
```

`npm test` checks the SCE parser against `seed/xu-holdings-sce-12mo.csv`, unpdf text, `pdftotext -layout` text, and `test/fixtures/bill0-original.pdf`, plus winter, transition, unknown-utility, and gap cases.

## Data model

- `sites` — a location
- `meters` — one utility meter on a site
- `bills` — one row per meter per billing period (or one row per unmatched file). Several rows may share `r2_key` when they came from the same PDF. Totals are not rolled up across meters.

Bill columns: `utility`, `customer_name`, `customer_account`, `service_account`, `meter_id`, `pod_id`, `service_address`, `service_city`, `service_state`, `service_zip`, `rate_schedule`, `rin`, `billing_period_start`, `billing_period_end`, `billing_days`, `kwh_total`, `kwh_on_peak`, `kwh_mid_peak`, `kwh_off_peak`, `kwh_super_off_peak`, `demand_kw_max`, `demand_kw_on_peak`, `demand_kw_mid_peak`, `demand_kw_off_peak`, `demand_kw_super_off_peak`, `energy_charges_usd`, `demand_charges_usd`, `other_charges_usd`, `total_new_charges_usd`, `amount_due_usd`, `due_date`, `bill_prepared_date`, `service_voltage`, `source_file`, `parser_id`, `parse_confidence`, `notes`.
