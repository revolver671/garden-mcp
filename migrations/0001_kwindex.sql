-- Dispatch 073 — the garden keyword inverted index.
--
-- Applied by the verdict session:
--   npx wrangler d1 migrations apply garden-index --remote
--
-- Terms and paths are plaintext here by the operator's ruling (7 Sep 2026); the
-- memory files themselves stay encrypted in R2. Nothing depends on these
-- tables existing: an unapplied migration means searchFilesDetailed catches
-- the D1 error and falls back to the old scan.

CREATE TABLE files (path TEXT PRIMARY KEY, room TEXT NOT NULL, indexed_at TEXT NOT NULL, r2_updated_at TEXT NOT NULL);
CREATE INDEX files_room ON files(room);
CREATE TABLE postings (term TEXT NOT NULL, path TEXT NOT NULL, tf INTEGER NOT NULL, PRIMARY KEY(term, path));
CREATE INDEX postings_path ON postings(path);
CREATE TABLE pathterms (term TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY(term, path));
