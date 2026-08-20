-- Reference-mode raw.
--
-- A folder hoppr indexes files that stay exactly where they are: hoppr records
-- the pointer and the extracted text, never a copy of the bytes. `path` then
-- refers to nothing inside the store, so `external_path` carries the real
-- location and `raw_mode` says which world a row lives in.
ALTER TABLE raw ADD COLUMN external_path TEXT;
ALTER TABLE raw ADD COLUMN raw_mode TEXT NOT NULL DEFAULT 'copy';
CREATE INDEX raw_external ON raw(external_path) WHERE external_path IS NOT NULL;
