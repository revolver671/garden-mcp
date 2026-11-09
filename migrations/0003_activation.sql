-- Dispatch 074 — the activation ledger moves from R2 JSON blobs to D1 rows.
--
-- Applied by the verdict session, BEFORE the deploy:
--   npx wrangler d1 migrations apply garden-index --remote
--
-- WHAT THIS REPLACES. Three encrypted R2 objects that were read-modify-written
-- on every counted access:
--   meta/activation/ledger.json      { [path]: number[] }  -> accesses(kind='direct')
--   meta/activation/spread.json      { [path]: number[] }  -> accesses(kind='spread')
--   meta/activation/neighbours.json  { [path]: string[] }  -> neighbours(path, neighbour)
-- Measured on production at 3900a62: the ledger was ~2.9 s of a 4.0 s MCP
-- keyword search, and it was one growing object for the whole garden — two
-- sessions in the same second lost one another's accesses.
--
-- NO PRIMARY KEY ON `accesses`, ON PURPOSE. The blob arrays can carry duplicate
-- timestamps (two tool calls landing in the same millisecond each push an
-- entry). A PRIMARY KEY(path, ts, kind) would silently collapse those and
-- change the ACT-R sum. Rows here are append-only facts, not a set.
--
-- TWO INDEXES, ON PURPOSE. `accesses_path` is the dispatch's specified index
-- and serves carryPath's `WHERE path = ?`. `accesses_kind` leads with `kind`,
-- which is what readLedger/readSpread actually filter on
-- (`WHERE kind = ? ORDER BY path, ts`); with only the (path, kind, ts) index
-- that query is a full table scan plus a sort, and it runs on every warm
-- search. Added by the 074 executor; see REPORT.md.
--
-- BOUNDING. Rows are capped per (path, kind) at CAP = 50 — the first-ever
-- access plus the newest 49, exactly the shape appendCapped() produced in the
-- blob. The cap is applied on read AND enforced by pruneAccesses() in the
-- nightly, so the table cannot grow without bound. See src/activation.ts.
--
-- ROLLBACK. Redeploy the previous worker; the three R2 objects are left in
-- place by /migrate-activation and are still readable. These rows are inert.

CREATE TABLE accesses (path TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('direct','spread')));
CREATE INDEX accesses_path ON accesses(path, kind, ts);
CREATE INDEX accesses_kind ON accesses(kind, path, ts);
CREATE TABLE neighbours (path TEXT NOT NULL, neighbour TEXT NOT NULL, PRIMARY KEY(path, neighbour));
