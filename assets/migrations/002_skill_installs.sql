-- Where an accepted skill has been installed, so `uninstall` can find it and
-- so a re-install is idempotent rather than writing a second copy.
CREATE TABLE skill_installs (
  slug         TEXT NOT NULL,
  target       TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  PRIMARY KEY (slug, target)
);
