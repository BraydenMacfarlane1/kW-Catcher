-- Logan City electric total, non-electric city charges, and embedded tax.
-- Existing rows stay blank. Additive only.
ALTER TABLE bills ADD COLUMN energy_demand_combined_usd TEXT NOT NULL DEFAULT '';
ALTER TABLE bills ADD COLUMN electric_total_usd TEXT NOT NULL DEFAULT '';
ALTER TABLE bills ADD COLUMN non_electric_charges_usd TEXT NOT NULL DEFAULT '';
ALTER TABLE bills ADD COLUMN charges_tax_inclusive TEXT NOT NULL DEFAULT '';
ALTER TABLE bills ADD COLUMN embedded_tax_rate TEXT NOT NULL DEFAULT '';
