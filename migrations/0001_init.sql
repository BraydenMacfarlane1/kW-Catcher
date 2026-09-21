CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE meters (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  meter_id TEXT NOT NULL,
  utility TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL DEFAULT '',
  customer_account TEXT NOT NULL DEFAULT '',
  service_account TEXT NOT NULL DEFAULT '',
  pod_id TEXT NOT NULL DEFAULT '',
  service_address TEXT NOT NULL DEFAULT '',
  service_city TEXT NOT NULL DEFAULT '',
  service_state TEXT NOT NULL DEFAULT '',
  service_zip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (site_id, meter_id)
);

CREATE TABLE bills (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  r2_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'needs_parser', 'failed')),
  source_key TEXT NOT NULL UNIQUE,
  text_excerpt TEXT NOT NULL DEFAULT '',
  utility TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL DEFAULT '',
  customer_account TEXT NOT NULL DEFAULT '',
  service_account TEXT NOT NULL DEFAULT '',
  meter_id TEXT NOT NULL DEFAULT '',
  pod_id TEXT NOT NULL DEFAULT '',
  service_address TEXT NOT NULL DEFAULT '',
  service_city TEXT NOT NULL DEFAULT '',
  service_state TEXT NOT NULL DEFAULT '',
  service_zip TEXT NOT NULL DEFAULT '',
  rate_schedule TEXT NOT NULL DEFAULT '',
  rin TEXT NOT NULL DEFAULT '',
  billing_period_start TEXT NOT NULL DEFAULT '',
  billing_period_end TEXT NOT NULL DEFAULT '',
  billing_days TEXT NOT NULL DEFAULT '',
  kwh_total TEXT NOT NULL DEFAULT '',
  kwh_on_peak TEXT NOT NULL DEFAULT '',
  kwh_mid_peak TEXT NOT NULL DEFAULT '',
  kwh_off_peak TEXT NOT NULL DEFAULT '',
  kwh_super_off_peak TEXT NOT NULL DEFAULT '',
  demand_kw_max TEXT NOT NULL DEFAULT '',
  demand_kw_on_peak TEXT NOT NULL DEFAULT '',
  demand_kw_mid_peak TEXT NOT NULL DEFAULT '',
  demand_kw_off_peak TEXT NOT NULL DEFAULT '',
  demand_kw_super_off_peak TEXT NOT NULL DEFAULT '',
  energy_charges_usd TEXT NOT NULL DEFAULT '',
  demand_charges_usd TEXT NOT NULL DEFAULT '',
  other_charges_usd TEXT NOT NULL DEFAULT '',
  total_new_charges_usd TEXT NOT NULL DEFAULT '',
  amount_due_usd TEXT NOT NULL DEFAULT '',
  due_date TEXT NOT NULL DEFAULT '',
  bill_prepared_date TEXT NOT NULL DEFAULT '',
  service_voltage TEXT NOT NULL DEFAULT '',
  source_file TEXT NOT NULL DEFAULT '',
  parser_id TEXT NOT NULL DEFAULT '',
  parse_confidence TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT ''
);

CREATE INDEX bills_site_period ON bills (site_id, meter_id, billing_period_start);
CREATE INDEX meters_site ON meters (site_id);
