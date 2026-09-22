-- Optional site profile stored by POST /api/v1/sites.
-- Existing rows stay blank. The HTML create form still only sends name.
ALTER TABLE sites ADD COLUMN utility TEXT NOT NULL DEFAULT '';
ALTER TABLE sites ADD COLUMN address TEXT NOT NULL DEFAULT '';
ALTER TABLE sites ADD COLUMN city TEXT NOT NULL DEFAULT '';
ALTER TABLE sites ADD COLUMN state TEXT NOT NULL DEFAULT '';
ALTER TABLE sites ADD COLUMN zip TEXT NOT NULL DEFAULT '';
ALTER TABLE sites ADD COLUMN notes TEXT NOT NULL DEFAULT '';
ALTER TABLE sites ADD COLUMN customer_name TEXT NOT NULL DEFAULT '';
