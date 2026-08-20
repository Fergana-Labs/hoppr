-- hoppr schema v1
--
-- The whole file is derivable from raw/ + curated/. `hoppr reindex` drops the
-- database and rebuilds it, so nothing here is ever migrated painfully or
-- backed up: a migration that goes wrong is answered with "delete it and
-- reindex". Migrations exist only so an incremental upgrade doesn't force a
-- full re-chunk and re-embed.

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- ══════════════════════════════════════════════════════════════════
-- TIER 1 mirror — append-only
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE raw (
  id            TEXT PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL,
  source        TEXT NOT NULL,
  external_id   TEXT UNIQUE,
  media_type    TEXT NOT NULL,
  title         TEXT,
  bytes         INTEGER NOT NULL,
  content_hash  TEXT NOT NULL,
  created       INTEGER NOT NULL,
  captured      INTEGER NOT NULL,
  file_mtime_ms INTEGER NOT NULL DEFAULT 0,
  -- Extracted plain text. Derived, so it lives here and never in raw/ —
  -- which means an improved extractor can re-derive better text from
  -- captures you already have.
  text          TEXT,
  origin        TEXT,
  -- A session still being appended to. Indexed and searchable, but not
  -- curated: spending an LLM call on a half-written transcript is waste.
  partial       INTEGER NOT NULL DEFAULT 0,

  -- Stale-flag reconciler. Staleness is a hash comparison, never a bare
  -- boolean, so re-saving an unchanged file costs nothing.
  curate_stale  INTEGER NOT NULL DEFAULT 1,
  curate_hash   TEXT,
  curate_fails  INTEGER NOT NULL DEFAULT 0,
  curate_error  TEXT
);
CREATE INDEX raw_captured ON raw(captured DESC);
CREATE INDEX raw_kind ON raw(kind);
-- Partial index: the sweep scans only rows that need work. A row that has
-- failed 3 times falls out of this index permanently — terminal per row, not
-- per batch, so one poison capture cannot wedge every future pass.
CREATE INDEX raw_curate_todo ON raw(captured)
  WHERE curate_stale = 1 AND curate_fails < 3 AND partial = 0;

-- ══════════════════════════════════════════════════════════════════
-- TIER 2 mirror — DROP TABLE is a supported recovery path
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE wiki (
  id           TEXT PRIMARY KEY,
  path         TEXT NOT NULL UNIQUE,
  slug         TEXT NOT NULL,
  page_type    TEXT NOT NULL,          -- source|concept|entity|comparison|digest
  title        TEXT NOT NULL,
  summary      TEXT,
  body         TEXT NOT NULL DEFAULT '',
  project      TEXT,
  confidence   TEXT NOT NULL DEFAULT 'medium',
  fields       TEXT,                   -- JSON: user-defined schema fields
  created      INTEGER NOT NULL,
  updated      INTEGER NOT NULL,
  pass_id      TEXT,
  source_hash  TEXT,
  prompt_hash  TEXT,
  pinned       INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX wiki_type_slug ON wiki(page_type, slug);
CREATE INDEX wiki_updated ON wiki(updated DESC);

CREATE TABLE wiki_sources (
  page_id TEXT NOT NULL REFERENCES wiki(id) ON DELETE CASCADE,
  raw_id  TEXT NOT NULL,
  PRIMARY KEY (page_id, raw_id)
);
CREATE INDEX wiki_sources_raw ON wiki_sources(raw_id);

CREATE TABLE wiki_tags (
  page_id TEXT NOT NULL REFERENCES wiki(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  origin  TEXT NOT NULL DEFAULT 'agent',   -- 'agent' | 'user' (user tags survive)
  PRIMARY KEY (page_id, tag)
);
CREATE INDEX wiki_tags_tag ON wiki_tags(tag);

CREATE TABLE wiki_links (
  from_id  TEXT NOT NULL REFERENCES wiki(id) ON DELETE CASCADE,
  to_slug  TEXT NOT NULL,
  route    TEXT NOT NULL DEFAULT 'related',
  resolved INTEGER NOT NULL DEFAULT 0,     -- 0 => dangling [[link]], a lint finding
  PRIMARY KEY (from_id, to_slug, route)
);
CREATE INDEX wiki_links_to ON wiki_links(to_slug);

-- ── extraction tables (the taxonomy is itself one of these) ──
CREATE TABLE tbl_defs (
  name        TEXT PRIMARY KEY,
  def         TEXT NOT NULL,
  def_hash    TEXT NOT NULL,
  prompt_hash TEXT,
  builtin     INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL
);
CREATE TABLE tbl_rows (
  table_name  TEXT NOT NULL,
  row_id      TEXT NOT NULL,
  raw_id      TEXT,
  page_id     TEXT,
  data        TEXT NOT NULL,             -- JSON object keyed by column
  pass_id     TEXT,
  source_hash TEXT,
  prompt_hash TEXT,
  pinned      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (table_name, row_id)
);
CREATE INDEX tbl_rows_raw ON tbl_rows(raw_id);

-- ── skills ──
CREATE TABLE skills (
  slug           TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL,
  path           TEXT,
  -- Proposed until a human accepts: a skill changes how every future agent
  -- session behaves, so it is the one thing here that is not automatic.
  state          TEXT NOT NULL DEFAULT 'proposed',
  evidence_count INTEGER NOT NULL DEFAULT 0,
  confidence     REAL NOT NULL DEFAULT 0,
  created        INTEGER NOT NULL,
  updated        INTEGER NOT NULL,
  pass_id        TEXT,
  prompt_hash    TEXT,
  pinned         INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE skill_sources (
  slug   TEXT NOT NULL REFERENCES skills(slug) ON DELETE CASCADE,
  raw_id TEXT NOT NULL,
  role   TEXT NOT NULL DEFAULT 'exemplar',   -- exemplar | failure | variant
  PRIMARY KEY (slug, raw_id)
);

-- ══════════════════════════════════════════════════════════════════
-- THE UNIFIED SEARCH PROJECTION
--
-- Everything searchable lands here with a tier and a kind: raw captures,
-- wiki pages, extracted table rows, and skills. One FTS index and one vector
-- index over one table means every artifact type is searchable both
-- lexically and semantically by default — including types added later.
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE docs (
  id           TEXT PRIMARY KEY,   -- 'raw:<id>' | 'wiki:<type>/<slug>' | 'row:<t>/<id>' | 'skill:<slug>'
  tier         TEXT NOT NULL,      -- 'raw' | 'curated'
  kind         TEXT NOT NULL,
  ref_id       TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  summary      TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  tags_text    TEXT NOT NULL DEFAULT '',
  project      TEXT,
  confidence   TEXT NOT NULL DEFAULT 'medium',
  created      INTEGER NOT NULL,
  updated      INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  embed_stale  INTEGER NOT NULL DEFAULT 1,
  embed_hash   TEXT,
  embed_fails  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX docs_tier_kind ON docs(tier, kind);
CREATE INDEX docs_ref ON docs(ref_id);
CREATE INDEX docs_created ON docs(created DESC);
CREATE INDEX docs_embed_todo ON docs(updated) WHERE embed_stale = 1 AND embed_fails < 3;

CREATE VIRTUAL TABLE docs_fts USING fts5(
  title, summary, tags_text, body,
  content='docs', content_rowid='rowid',
  tokenize="porter unicode61 remove_diacritics 2 tokenchars '-_/.@'"
);
CREATE TRIGGER docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO docs_fts(rowid, title, summary, tags_text, body)
    VALUES (new.rowid, new.title, new.summary, new.tags_text, new.body);
END;
CREATE TRIGGER docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, title, summary, tags_text, body)
    VALUES ('delete', old.rowid, old.title, old.summary, old.tags_text, old.body);
END;
CREATE TRIGGER docs_au AFTER UPDATE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, title, summary, tags_text, body)
    VALUES ('delete', old.rowid, old.title, old.summary, old.tags_text, old.body);
  INSERT INTO docs_fts(rowid, title, summary, tags_text, body)
    VALUES (new.rowid, new.title, new.summary, new.tags_text, new.body);
END;

CREATE TABLE chunks (
  id         INTEGER PRIMARY KEY,
  doc_id     TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  ord        INTEGER NOT NULL,
  heading    TEXT,
  text       TEXT NOT NULL,
  chunk_hash TEXT NOT NULL
);
CREATE UNIQUE INDEX chunks_doc_ord ON chunks(doc_id, ord);
CREATE INDEX chunks_hash ON chunks(chunk_hash);

-- Keyed by content, not by row id, so it survives a full rebuild: `reindex`
-- re-inserts vectors straight from cache at zero embedding cost. Vectors are
-- the only expensive-to-recreate artifact in the whole system.
CREATE TABLE embedding_cache (
  chunk_hash TEXT NOT NULL,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vec        BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chunk_hash, model)
);

-- ══════════════════════════════════════════════════════════════════
-- machinery
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE taxonomy_versions (
  version    INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  change_log TEXT NOT NULL
);

CREATE TABLE watermarks (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE connector_cursors (
  connector   TEXT NOT NULL,
  source_key  TEXT NOT NULL,
  cursor      TEXT NOT NULL,
  last_ok_at  INTEGER,
  last_error  TEXT,
  error_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (connector, source_key)
);

CREATE TABLE jobs (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL,
  payload      TEXT NOT NULL DEFAULT '{}',
  dedup_key    TEXT,
  priority     INTEGER NOT NULL DEFAULT 100,
  run_after    INTEGER NOT NULL DEFAULT 0,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  claimed_by   TEXT,
  lease_until  INTEGER,
  state        TEXT NOT NULL DEFAULT 'pending',
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX jobs_dedup ON jobs(dedup_key)
  WHERE dedup_key IS NOT NULL AND state IN ('pending','running');
CREATE INDEX jobs_claim ON jobs(state, priority, run_after);

-- Two concurrent ingests naming the same concept must converge on one page
-- rather than forking into `rrf-fusion.md` and `rrf-fusion-1.md`. The unique
-- insert IS the reservation; the loser reads the winner's page and appends.
CREATE TABLE name_reservations (
  slug      TEXT PRIMARY KEY,
  page_type TEXT NOT NULL,
  pass_id   TEXT,
  at        INTEGER NOT NULL
);

-- Curated-only by construction: the curator has no write path to tier 1,
-- so there is nothing from tier 1 that could ever need undoing.
CREATE TABLE journal (
  id          INTEGER PRIMARY KEY,
  pass_id     TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  target_kind TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  op          TEXT NOT NULL,
  before      TEXT,
  after       TEXT,
  git_sha     TEXT
);
CREATE INDEX journal_pass ON journal(pass_id);

CREATE TABLE tool_calls (
  id      INTEGER PRIMARY KEY,
  pass_id TEXT, ts INTEGER NOT NULL,
  server  TEXT NOT NULL, tool TEXT NOT NULL,
  args    TEXT, ok INTEGER NOT NULL, ms INTEGER
);

CREATE TABLE llm_calls (
  id            INTEGER PRIMARY KEY,
  at            INTEGER NOT NULL,
  provider      TEXT, model TEXT, tier TEXT, purpose TEXT,
  input_tokens  INTEGER, output_tokens INTEGER,
  cost_usd      REAL, ok INTEGER NOT NULL, ms INTEGER
);
