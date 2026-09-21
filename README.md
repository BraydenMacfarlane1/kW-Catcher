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
2. Each file is stored in R2, text is extracted with unpdf, and the parser registry runs.
3. Each meter on a PDF becomes its own bill row. Those rows share one R2 object (`r2_key`) and upsert on `(site_id, meter_id, billing_period_start, billing_period_end)`. kWh and demand are stored per meter and are never added together. A file that does not identify a meter and period upserts on a hash source key.
4. The site page shows a separate table per `meter_id`. Missing months are computed for that meter only, between its own earliest and latest bill.
5. If no parser matches, one `needs_parser` row is saved: the PDF and a text excerpt are kept, and bill fields are left blank (`line_items_json` is `[]`).
6. **Download this meter** on each table, or `GET /sites/:id/meters/:meterId/export.csv`. **All meters CSV** (`GET /sites/:id/export.csv`) is the Sun Daddy ingest contract v1 columns, one row per meter, with no total row. `id`, `site_id`, `r2_key`, `created_at`, and `status` (`ok`, `needs_parser`, `failed`) are appended after the contract columns.
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

When a bill has a **Details of your new charges** section, each charge line is stored in `line_items_json` as `{label, amount_usd, category}` with category `tax`, `fee`, `energy`, `demand`, or `other`. `taxes_usd` sums lines the bill labels as tax (UUT, state tax). `fees_usd` sums fee-like labels (customer charge, franchise fees, wildfire fund, public purpose, fixed recovery, and similar). `other_charges_usd` is the residual, so energy + demand + taxes + fees + other equals `total_new_charges_usd` within rounding. The "your charges include" bullets restate dollars already inside the charge lines, so they stay out of `fees_usd` and `line_items_json`. Bills without that section leave `taxes_usd` and `fees_usd` blank, `line_items_json` as `[]`, and keep the summary other-charges amount, which still reconciles the same way.

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

## Sun Daddy ingest contract v1

CSV export, the D1 `bills` columns, the SCE parser, and `seed/xu-holdings-sce-12mo.csv` use this contract. Column names stay the kW-Catcher names; Sun Daddy maps them on ingest. Every export includes every column below. A cell is blank only when that value is absent on the bill.

Required: `billing_period_start`, `billing_period_end` (`YYYY-MM-DD`, not a month index), `kwh_total`, `demand_kw_max`, `kwh_on_peak`, `kwh_mid_peak`, `kwh_off_peak`, `kwh_super_off_peak`. A season with no on-peak or super-off-peak leaves that bucket blank. A bucket the bill does report is kept.

Strongly recommended: `meter_id`, `service_account`, `customer_account`, `utility`, `rate_schedule`, `service_address`, `service_city`, `service_state`, `service_zip`, `billing_days`, `parse_confidence`, `source_file`, `parser_id`.

Optional provenance: `energy_charges_usd`, `demand_charges_usd`, `taxes_usd`, `fees_usd`, `other_charges_usd` (residual), `total_new_charges_usd`, `amount_due_usd`, `due_date`, `bill_prepared_date`, `line_items_json`, `demand_kw_on_peak`, `demand_kw_mid_peak`, `demand_kw_off_peak`, `demand_kw_super_off_peak`, `notes`, `pod_id`, `rin`, `service_voltage`, `customer_name`.

`energy_charges_usd + demand_charges_usd + taxes_usd + fees_usd + other_charges_usd` matches `total_new_charges_usd` within rounding. Meters are never aggregated into one row.
