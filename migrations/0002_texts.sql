-- Dispatch 075 — the garden TEXT MIRROR.
--
-- Applied by the verdict session:
--   npx wrangler d1 migrations apply garden-index --remote
--
-- WHAT THIS IS. One row per .md file in the garden holding that file's whole
-- decrypted text. R2 stays the encrypted store of record and the only backup;
-- this table is a derived, disposable mirror that exists so the keyword search
-- path never has to touch R2 at all. Plaintext here is the operator's ruling of
-- 7 Sep 2026, which extends the 073 ruling (terms and paths) to the text.
--
-- WHY. At 073b a keyword search over `athena` spent 1.2-2.0 s on the R2 list
-- (the staleness guard) and 0.4-1.0 s on five R2 gets + decrypts (the
-- snippets) against 0.3 s of actual searching. Both of those are reads of
-- things D1 can hold itself.
--
-- SIZE. D1's documented ceiling is 2,000,000 bytes for a string, BLOB or table
-- row (developers.cloudflare.com/d1/platform/limits/, "Maximum string, BLOB or
-- table row size"). The largest .md in the garden is athena/build-state.md at
-- 389 KB, so every file fits in one row with 5x headroom and NO CHUNKING IS
-- NEEDED. kwindex.ts refuses to write a row above TEXTS_MAX_BYTES rather than
-- truncating one: a truncated mirror would produce a wrong snippet line, while
-- a MISSING row is already handled — the search reads that one file from R2
-- and repairs the row in passing.
--
-- ROLLBACK. Redeploy the previous worker; the rows are inert. Dropping the
-- table is never required and never urgent.

CREATE TABLE texts (path TEXT PRIMARY KEY, room TEXT NOT NULL, content TEXT NOT NULL, bytes INTEGER NOT NULL, r2_updated_at TEXT NOT NULL);
CREATE INDEX texts_room ON texts(room);
