-- One stored PDF (r2_key) can back many bill rows, one per meter.
-- Rows stay separate: do not sum kWh or demand across meter_id.
CREATE INDEX IF NOT EXISTS bills_r2_key ON bills (r2_key);
