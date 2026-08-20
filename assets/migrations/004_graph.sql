-- Typed entities and relations over the corpus.
--
-- Nodes are keyed by (type, key) where `key` is a normalised name, so the same
-- person mentioned three ways collapses to one node rather than three. The
-- display `name` keeps whatever form was seen most.
CREATE TABLE IF NOT EXISTS graph_nodes (
  id         TEXT PRIMARY KEY,          -- '<type>:<key>'
  type       TEXT NOT NULL,
  key        TEXT NOT NULL,             -- normalised: lowercase, collapsed spaces
  name       TEXT NOT NULL,             -- display form
  summary    TEXT,
  mentions   INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER,
  last_seen  INTEGER,
  UNIQUE(type, key)
);
CREATE INDEX IF NOT EXISTS graph_nodes_type ON graph_nodes(type);

-- Every edge cites the capture it was read from. An assertion with no source
-- is a hallucination we would have no way to audit, so raw_id is NOT NULL.
CREATE TABLE IF NOT EXISTS graph_edges (
  id        INTEGER PRIMARY KEY,
  from_id   TEXT NOT NULL,
  predicate TEXT NOT NULL,
  to_id     TEXT NOT NULL,
  raw_id    TEXT NOT NULL,
  evidence  TEXT,                       -- the sentence it was read from
  at        INTEGER NOT NULL,
  UNIQUE(from_id, predicate, to_id, raw_id)
);
CREATE INDEX IF NOT EXISTS graph_edges_from ON graph_edges(from_id);
CREATE INDEX IF NOT EXISTS graph_edges_to   ON graph_edges(to_id);
CREATE INDEX IF NOT EXISTS graph_edges_raw  ON graph_edges(raw_id);

-- Which captures have been through graph extraction, so a pass is incremental
-- rather than re-reading the corpus every night.
CREATE TABLE IF NOT EXISTS graph_seen (
  raw_id      TEXT PRIMARY KEY,
  prompt_hash TEXT,
  at          INTEGER NOT NULL
);
