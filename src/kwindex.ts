/**
 * The Garden — keyword inverted index (D1)
 *
 * Dispatch 073. The keyword scan listed every .md under the scope and did one
 * R2 get + decrypt + tokenize per file, six in flight: 17-19 s per query over
 * `athena` (~285 files), and Cloudflare 1102 (resource limits) about one call
 * in three. This module holds the index that replaces that scan, and the
 * tokenizer both sides share.
 *
 * WHAT IS IN PLAINTEXT, AND WHY THAT IS ALLOWED. The memory files stay
 * encrypted at rest in R2 (src/crypto.ts), which remains the store of record
 * and the only backup. D1 holds the stemmed terms, their per-file counts, the
 * paths — and, since dispatch 075, the whole decrypted TEXT of every file, in
 * the `texts` table. Both are the operator's ruling of 7 Sep 2026.
 *
 * WHAT CHANGED AT 075. Before it, every snippet was read back from the
 * encrypted file, and an R2 list per search told the guard what was stale;
 * those two R2 round trips were 80% of a search. Now the snippet comes from
 * `texts` and the staleness comparison has moved to the nightly reconcile. The
 * property that replaces the guard: the search reflects what the INDEX knows.
 * A write that bypasses the hooks is invisible to search until the nightly (or
 * /reindex-keywords) lands it. That is a deliberate trade, not an oversight —
 * every write verb in storage.ts hooks the index, and the mirror is written in
 * the same batch as the postings, so there is no window between them.
 *
 * NOT A ONE-WAY DOOR. Nothing depends on the database being present or full.
 * If `env.KWINDEX` is missing, the migration is unapplied, or the index has no
 * rows for the scope, searchFilesDetailed falls back to the old scan and fills
 * both tables in passing. Rollback is a redeploy; the rows are inert.
 */

import type { Env } from "./types";

// --------------------------------------------------------------------------
// Tokenizer — moved here from storage.ts (dispatch 073) so the indexer and the
// scorer cannot drift. storage.ts imports these; there is exactly ONE
// `function stemTerm(` across src/ and it is the one below.
// --------------------------------------------------------------------------

// Common words that carry no search signal — dropped before scoring.
export const SEARCH_STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "and",
  "or", "is", "was", "for", "with", "that", "this", "it",
]);

/** Weight for a term appearing in the file path. */
export const PATH_MATCH_BONUS = 5;

// Light stemming: collapse common inflections so "running"/"runs"/"ran"-ish
// forms unify with their root. Applied to both query and body tokens.
export function stemTerm(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

// Split text into lowercase alphanumeric tokens.
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) || [];
}

// Parse a raw query into the unique set of stemmed, non-stopword terms.
export function parseQueryTerms(query: string): string[] {
  const terms = tokenize(query)
    .filter((w) => !SEARCH_STOPWORDS.has(w))
    .map(stemTerm)
    .filter((w) => w.length > 0);
  return [...new Set(terms)];
}

// --------------------------------------------------------------------------
// Index shape
// --------------------------------------------------------------------------

/**
 * D1 allows at most 100 bound parameters per statement
 * (developers.cloudflare.com/d1/platform/limits/). A `postings` row binds 3
 * (term, path, tf) and a `pathterms` row binds 2 (term, path), so the multi-row
 * INSERTs are chunked at 30 and 45 rows — 90 parameters each, ten under the
 * wall. A 50 KB file is ~3-6k distinct terms, i.e. ~200 statements, which is
 * why the statements are then grouped into batches of 50 rather than sent as
 * one enormous batch.
 */
const D1_MAX_BOUND_PARAMS = 100;
const POSTINGS_ROWS_PER_STMT = Math.floor((D1_MAX_BOUND_PARAMS - 10) / 3); // 30
const PATHTERMS_ROWS_PER_STMT = Math.floor((D1_MAX_BOUND_PARAMS - 10) / 2); // 45
const STMTS_PER_BATCH = 50;

/**
 * A query with more terms than this would push the score statement past the
 * bound-parameter limit: 2 per term, plus 2 coverage denominators, plus the
 * scope bind (1), the skip binds (2), the `since` bind (1) and the two LIMIT /
 * inline-size binds (2) — 40 terms is 87 of the 100. Nobody types one; if they
 * do, storage.ts falls back to the scan rather than truncating the query,
 * because a truncated query is a wrong answer that looks right.
 */
export const KW_MAX_QUERY_TERMS = 40;

/**
 * Largest text the mirror will store in one row.
 *
 * D1's documented ceiling is 2,000,000 bytes for a string, BLOB or table row
 * (developers.cloudflare.com/d1/platform/limits/, "Maximum string, BLOB or
 * table row size", read 7 Sep 2026). The largest file in the garden is
 * athena/build-state.md at 389 KB, so nothing is near it; the 100 KB in that
 * same table is the maximum SQL STATEMENT length, which the text does not
 * touch because it is a bound parameter and not part of the statement text —
 * if it were, the 2 MB string limit would be unreachable.
 *
 * A file over this is NOT truncated and NOT chunked: it simply gets no row.
 * Truncating would hand bestLineFor a different document and produce a wrong
 * line number, which is the one thing the mirror must never do. A missing row
 * is a case the search already handles — it reads that one file from R2. The
 * visible cost of an oversized file is that /kwindex-status shows
 * files > texts for its room, which is the alarm you want.
 */
export const TEXTS_MAX_BYTES = 1_900_000;

/**
 * Largest text the SEARCH will pull inline from D1, per row.
 *
 * The limits page documents no per-query RESPONSE ceiling — result
 * serialization just runs inside the Workers memory limit — so the mirror
 * budgets itself one: a keyword search returns at most MAX_SEARCH_RESULTS (20)
 * rows, and 20 x 512 KB is 10 MB, the response size this design assumes. A row
 * bigger than this comes back NULL and the search reads that one file from R2
 * exactly as if the row were missing: slower by one get, never wrong.
 */
export const TEXTS_INLINE_MAX_BYTES = 512 * 1024;

/** UTF-8 byte length — what the `bytes` column and the two limits above mean. */
export function textBytes(content: string): number {
  return new TextEncoder().encode(content).length;
}

/** The room a memory-relative path belongs to: `athena/lanes/x.md` -> `athena`. */
export function roomOf(path: string): string {
  return path.split("/")[0];
}

/**
 * A path with a dot-prefixed segment is invisible to listPath (and therefore to
 * /ro/list and every walk built on it), so it is invisible to the index too.
 * Keeping the two definitions of "a file in the garden" identical is what makes
 * /kwindex-status?room=X .files equal a recursive /ro/list .md count.
 */
export function isHiddenPath(path: string): boolean {
  return path.split("/").some((s) => s.startsWith("."));
}

/**
 * Machine pages nobody searches, kept out of the index (767). athena/STATE.md
 * is rewritten every 15 minutes (~471 terms each time) and athena/box/*.jsonl
 * is the box page's row log (733); every write reindexed the whole file for a
 * search that never names them. STATE is read by path, the box page reads its
 * own jsonl. isHiddenPath set the precedent: the index is a search aid, not a
 * mirror of the store, so a page nobody queries costs nothing per write.
 *
 * Rows already in the index for these paths are removed once at the landing
 * (kwIndexRemove), not on every write: this list gates writes, it does not
 * sweep history.
 */
export const NO_INDEX: ReadonlyArray<string> = ["athena/STATE.md"];

/** The one no-index prefix: athena/box/ holds machine-written .jsonl logs. */
const NO_INDEX_BOX_PREFIX = "athena/box/";

/**
 * True for an exact path in NO_INDEX and for a `athena/box/*.jsonl` path.
 * Exact on purpose: `athena//STATE.md` or a trailing slash is a different
 * path and gets indexed, exactly as a person listing files would see it.
 */
export function isNoIndexPath(path: string): boolean {
  if (NO_INDEX.includes(path)) return true;
  return path.startsWith(NO_INDEX_BOX_PREFIX) && path.endsWith(".jsonl");
}

/** Body term frequencies: the map scoreOneFile builds, stopwords dropped. */
export function bodyTermFreqs(content: string): Map<string, number> {
  const freq = new Map<string, number>();
  for (const token of tokenize(content)) {
    if (SEARCH_STOPWORDS.has(token)) continue;
    const stemmed = stemTerm(token);
    freq.set(stemmed, (freq.get(stemmed) || 0) + 1);
  }
  return freq;
}

/**
 * Terms present in the file path (title/name matching) — the PATH_MATCH_BONUS
 * input. Stopwords are dropped here too: a query term is never a stopword
 * (parseQueryTerms drops them), so a stopword row could never be read.
 */
export function pathTermSet(path: string): Set<string> {
  const out = new Set<string>();
  for (const token of tokenize(path)) {
    if (SEARCH_STOPWORDS.has(token)) continue;
    out.add(stemTerm(token));
  }
  return out;
}

// --------------------------------------------------------------------------
// Writes
// --------------------------------------------------------------------------

function chunkedBatches(stmts: D1PreparedStatement[]): D1PreparedStatement[][] {
  const out: D1PreparedStatement[][] = [];
  for (let i = 0; i < stmts.length; i += STMTS_PER_BATCH) {
    out.push(stmts.slice(i, i + STMTS_PER_BATCH));
  }
  return out;
}

/**
 * Run the index statements in batches and return the summed meta.rows_written.
 * 767: D1 bills every row a write touches — deletes, index entries included —
 * and writecount exists so the box page can show where that bill goes. The
 * sum is read from the batch RESULTS, after they have run; that is why the
 * writecount row is written separately, below, and not appended to the same
 * statement list (its value cannot be bound before it is known).
 */
async function runCounting(
  db: D1Database,
  stmts: D1PreparedStatement[]
): Promise<number> {
  let written = 0;
  for (const batch of chunkedBatches(stmts)) {
    for (const r of await db.batch(batch)) {
      written += r.meta?.rows_written ?? 0;
    }
  }
  return written;
}

/** Today's UTC day as `YYYY-MM-DD` — the writecount row key. */
function writecountDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Add `written` rows to today's writecount row for `path`. One row-write per
 * indexed write, the cost said aloud in the design: the counter must not cost
 * more than it explains. The upsert accumulates, so two writes to one path on
 * one day land as one row holding their sum.
 *
 * A throw here (the writecount migration unapplied, a D1 hiccup) is logged
 * and swallowed: the index write has already landed and must not be undone,
 * and the next write to the path tops the day's row up again.
 */
async function writecountBump(
  db: D1Database,
  path: string,
  written: number,
  now = new Date()
): Promise<void> {
  try {
    await db
      .prepare(
        "INSERT INTO writecount (day, path, rows) VALUES (?, ?, ?) " +
          "ON CONFLICT(day, path) DO UPDATE SET rows = rows + excluded.rows"
      )
      .bind(writecountDay(now), path, written)
      .run();
  } catch (e) {
    console.error("kwindex: writecount upsert failed (non-fatal):", path, e);
  }
}

/**
 * Replace one file's rows. Rows, not read-modify-write: two writers touching
 * different files never see each other, and two writers touching the SAME file
 * each land a complete replacement rather than one clobbering the other's
 * merge.
 *
 * The `files` row is INSERTed LAST on purpose. It is the freshness receipt: if
 * an earlier statement fails, no receipt exists, the nightly reconcile still
 * sees the file as unindexed, and it is repaired. A receipt written first would
 * certify a half-written index.
 *
 * THE TEXT MIRROR (075) is written here, in this same statement list, and
 * therefore in the same batch() round trip as the postings that precede it. It
 * costs no extra call: the text is already in hand — every caller has just
 * written or decrypted it. It is placed immediately BEFORE the receipt so that
 * the receipt keeps meaning "everything about this path is current, mirror
 * included".
 *
 * Callers invoke this AFTER the R2 put has succeeded and treat a throw as
 * non-fatal — the file write already happened and must not be undone.
 *
 * 767: a no-index path (isNoIndexPath — machine pages nobody searches)
 * returns before any statement, exactly as a hidden path does. The R2 write
 * that precedes this hook is untouched, so `read` still serves the file.
 */
export async function kwIndexUpsert(
  env: Env,
  path: string,
  content: string,
  r2UpdatedAt: string
): Promise<void> {
  const db = env.KWINDEX;
  if (!db) return;
  if (isHiddenPath(path) || isNoIndexPath(path)) return;

  const freq = bodyTermFreqs(content);
  const pterms = pathTermSet(path);

  const stmts: D1PreparedStatement[] = [
    db.prepare("DELETE FROM postings WHERE path = ?").bind(path),
    db.prepare("DELETE FROM pathterms WHERE path = ?").bind(path),
    db.prepare("DELETE FROM files WHERE path = ?").bind(path),
  ];

  const entries = [...freq];
  for (let i = 0; i < entries.length; i += POSTINGS_ROWS_PER_STMT) {
    const chunk = entries.slice(i, i + POSTINGS_ROWS_PER_STMT);
    const sql =
      "INSERT OR REPLACE INTO postings (term, path, tf) VALUES " +
      chunk.map(() => "(?, ?, ?)").join(", ");
    const binds: unknown[] = [];
    for (const [term, tf] of chunk) binds.push(term, path, tf);
    stmts.push(db.prepare(sql).bind(...binds));
  }

  const pathList = [...pterms];
  for (let i = 0; i < pathList.length; i += PATHTERMS_ROWS_PER_STMT) {
    const chunk = pathList.slice(i, i + PATHTERMS_ROWS_PER_STMT);
    const sql =
      "INSERT OR REPLACE INTO pathterms (term, path) VALUES " +
      chunk.map(() => "(?, ?)").join(", ");
    const binds: unknown[] = [];
    for (const term of chunk) binds.push(term, path);
    stmts.push(db.prepare(sql).bind(...binds));
  }

  // The text mirror (075). One row, whole file, replaced outright — same shape
  // as the postings above, for the same reason: two writers touching one path
  // each land a complete replacement rather than a merge.
  const bytes = textBytes(content);
  if (bytes <= TEXTS_MAX_BYTES) {
    stmts.push(
      db
        .prepare(
          "INSERT OR REPLACE INTO texts (path, room, content, bytes, r2_updated_at) VALUES (?, ?, ?, ?, ?)"
        )
        .bind(path, roomOf(path), content, bytes, r2UpdatedAt)
    );
  } else {
    // Never truncate: see TEXTS_MAX_BYTES. Drop any stale row for this path so
    // the search falls through to R2 rather than previewing an older version.
    stmts.push(db.prepare("DELETE FROM texts WHERE path = ?").bind(path));
    console.error(
      `kwindex: ${path} is ${bytes} bytes, over the ${TEXTS_MAX_BYTES}-byte row limit — indexed, but NOT mirrored; its snippets come from R2`
    );
  }

  stmts.push(
    db
      .prepare(
        "INSERT OR REPLACE INTO files (path, room, indexed_at, r2_updated_at) VALUES (?, ?, ?, ?)"
      )
      .bind(path, roomOf(path), new Date().toISOString(), r2UpdatedAt)
  );

  await writecountBump(db, path, await runCounting(db, stmts));
}

/**
 * Index an append by adding the APPENDED text's term counts to the postings
 * that are already there (767). The wall this stands on: appendFile joins
 * with `existing.trimEnd() + "\n\n" + newContent`, and the tokenizer sees
 * only [a-z0-9]+ runs, so the token split of `combined` is the token split of
 * the already-indexed text plus the token split of `appended` — trailing
 * whitespace holds no term and the join boundary holds no term. Adding
 * `appended`'s frequencies to the existing rows therefore lands the same tf
 * a full reindex of `combined` would, at the cost of the appended terms
 * instead of the whole file's. The accept's check E proves that equality
 * case by case; if the join ever changes, E is the check that catches it.
 *
 * `pathterms` is not touched — the path did not change. The `texts` mirror
 * and the `files` receipt are REPLACED, one row each, exactly as
 * kwIndexUpsert replaces them: the receipt last, over-limit text dropped
 * rather than truncated (an append can push a file over TEXTS_MAX_BYTES).
 *
 * A path with no `files` row was never indexed, so there is nothing to add
 * to: fall back to a full kwIndexUpsert of `combined`. One receipt read buys
 * that decision, and the fallback also carries the no-index and hidden-path
 * gates — but they are checked here first, so a machine page costs nothing
 * even on the append path.
 *
 * Callers invoke this AFTER the R2 put, with the same stamp the put wrote
 * into customMetadata, and treat a throw as non-fatal.
 */
export async function kwIndexAppend(
  env: Env,
  path: string,
  appended: string,
  combined: string,
  r2UpdatedAt: string
): Promise<void> {
  const db = env.KWINDEX;
  if (!db) return;
  if (isHiddenPath(path) || isNoIndexPath(path)) return;

  const seen = await db
    .prepare("SELECT 1 AS seen FROM files WHERE path = ?")
    .bind(path)
    .first("seen");
  if (!seen) return kwIndexUpsert(env, path, combined, r2UpdatedAt);

  const freq = bodyTermFreqs(appended);
  const stmts: D1PreparedStatement[] = [];

  const entries = [...freq];
  for (let i = 0; i < entries.length; i += POSTINGS_ROWS_PER_STMT) {
    const chunk = entries.slice(i, i + POSTINGS_ROWS_PER_STMT);
    const sql =
      "INSERT INTO postings (term, path, tf) VALUES " +
      chunk.map(() => "(?, ?, ?)").join(", ") +
      " ON CONFLICT(term, path) DO UPDATE SET tf = tf + excluded.tf";
    const binds: unknown[] = [];
    for (const [term, tf] of chunk) binds.push(term, path, tf);
    stmts.push(db.prepare(sql).bind(...binds));
  }

  const bytes = textBytes(combined);
  if (bytes <= TEXTS_MAX_BYTES) {
    stmts.push(
      db
        .prepare(
          "INSERT OR REPLACE INTO texts (path, room, content, bytes, r2_updated_at) VALUES (?, ?, ?, ?, ?)"
        )
        .bind(path, roomOf(path), combined, bytes, r2UpdatedAt)
    );
  } else {
    // Never truncate: see TEXTS_MAX_BYTES. Drop the stale row so the search
    // falls through to R2 rather than previewing the pre-append version.
    stmts.push(db.prepare("DELETE FROM texts WHERE path = ?").bind(path));
    console.error(
      `kwindex: ${path} is ${bytes} bytes, over the ${TEXTS_MAX_BYTES}-byte row limit — indexed, but NOT mirrored; its snippets come from R2`
    );
  }

  stmts.push(
    db
      .prepare(
        "INSERT OR REPLACE INTO files (path, room, indexed_at, r2_updated_at) VALUES (?, ?, ?, ?)"
      )
      .bind(path, roomOf(path), new Date().toISOString(), r2UpdatedAt)
  );

  await writecountBump(db, path, await runCounting(db, stmts));
}

/**
 * Mirror-only repair: write `texts` for a path whose postings are already
 * current. This is what a search does when it finds a top-K path with no
 * mirror row — it has just read and decrypted the file to produce the snippet,
 * so the row is free. It deliberately does NOT touch `files`: the receipt
 * describes the postings, which this call did not rebuild.
 */
export async function kwTextsUpsert(
  env: Env,
  path: string,
  content: string,
  r2UpdatedAt: string
): Promise<void> {
  const db = env.KWINDEX;
  if (!db) return;
  if (isHiddenPath(path)) return;
  const bytes = textBytes(content);
  if (bytes > TEXTS_MAX_BYTES) return;
  await db
    .prepare(
      "INSERT OR REPLACE INTO texts (path, room, content, bytes, r2_updated_at) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(path, roomOf(path), content, bytes, r2UpdatedAt)
    .run();
}

/**
 * Drop every row for a path, mirror included. Called after the R2 delete has
 * succeeded. Since 075 this is the ONLY thing that makes a deleted file
 * disappear from search results at once — nothing on the search path lists R2
 * any more, so a delete that skips this hook stays visible until the nightly.
 */
export async function kwIndexRemove(env: Env, path: string): Promise<void> {
  const db = env.KWINDEX;
  if (!db) return;
  await db.batch([
    db.prepare("DELETE FROM postings WHERE path = ?").bind(path),
    db.prepare("DELETE FROM pathterms WHERE path = ?").bind(path),
    db.prepare("DELETE FROM texts WHERE path = ?").bind(path),
    db.prepare("DELETE FROM files WHERE path = ?").bind(path),
  ]);
}

/** Bulk form of kwIndexRemove, for the guard's orphan sweep. */
export async function kwIndexRemoveMany(env: Env, paths: string[]): Promise<void> {
  const db = env.KWINDEX;
  if (!db || paths.length === 0) return;
  const stmts: D1PreparedStatement[] = [];
  const PER = D1_MAX_BOUND_PARAMS - 10; // 1 bound parameter per path
  for (let i = 0; i < paths.length; i += PER) {
    const chunk = paths.slice(i, i + PER);
    const marks = chunk.map(() => "?").join(", ");
    stmts.push(db.prepare(`DELETE FROM postings WHERE path IN (${marks})`).bind(...chunk));
    stmts.push(db.prepare(`DELETE FROM pathterms WHERE path IN (${marks})`).bind(...chunk));
    stmts.push(db.prepare(`DELETE FROM texts WHERE path IN (${marks})`).bind(...chunk));
    stmts.push(db.prepare(`DELETE FROM files WHERE path IN (${marks})`).bind(...chunk));
  }
  for (const batch of chunkedBatches(stmts)) {
    await db.batch(batch);
  }
}

// --------------------------------------------------------------------------
// Scope predicates
//
// scope ""             -> no filter (the whole tree)
// scope "athena"       -> files.room = ?     (the files_room index carries this)
// scope "athena/lanes" -> files.path LIKE ?  (prefix; LIKE metacharacters escaped)
// --------------------------------------------------------------------------

interface SqlFilter {
  sql: string;
  binds: unknown[];
}

function likePrefixEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

function scopeFilter(scope: string, col: string): SqlFilter {
  const clean = scope.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!clean) return { sql: "", binds: [] };
  if (!clean.includes("/")) return { sql: ` AND ${col}room = ?`, binds: [clean] };
  return {
    sql: ` AND ${col}path LIKE ? ESCAPE '\\'`,
    binds: [likePrefixEscape(clean) + "/%"],
  };
}

/**
 * SKIPPED_SEARCH_DIRS in SQL. GLOB, not LIKE: LIKE is case-insensitive over
 * ASCII in SQLite, and isSkippedKey in storage.ts is case-sensitive.
 *
 * `*` + `/briefs/` + `*` is exactly isSkippedKey's `segs.slice(1, -1)` test — a
 * segment named `briefs` with at least one segment before it (so not the room)
 * and at least one after it (so not the filename).
 */
function skipFilter(skipDirs: string[], col: string): SqlFilter {
  const binds: unknown[] = [];
  let sql = "";
  for (const d of skipDirs) {
    sql += ` AND ${col}path NOT GLOB ?`;
    binds.push(`*/${d}/*`);
  }
  return { sql, binds };
}

// --------------------------------------------------------------------------
// Reads
// --------------------------------------------------------------------------

export interface KwScoreRow {
  path: string;
  score: number;
  /**
   * The file's whole text, straight off the mirror. NULL when the row is
   * missing (never indexed since 075, or over TEXTS_MAX_BYTES) or when it is
   * over TEXTS_INLINE_MAX_BYTES; the caller reads that one file from R2.
   */
  content: string | null;
}

export interface KwScoreResult {
  /** Top `limit` paths, best first, each with its text. */
  rows: KwScoreRow[];
  /** Files under SKIPPED_SEARCH_DIRS inside the scope — what skipNote prints. */
  skippedFiles: number;
  /**
   * Indexed files under the scope, ignoring the query and `since`. Zero means
   * the index has nothing here, which is the caller's signal to run the scan
   * instead of reporting "no matches" for an empty table.
   */
  scopeFiles: number;
}

/**
 * A `since` bound: `AND f.r2_updated_at > ?`, on the same ISO-8601 strings the
 * write hooks stamp, so string order is time order.
 */
function sinceFilter(since: string | null, col: string): SqlFilter {
  if (!since) return { sql: "", binds: [] };
  return { sql: ` AND ${col}r2_updated_at > ?`, binds: [since] };
}

/**
 * Parse the `since` a caller typed into the ISO-8601 string the columns hold.
 *
 * Two forms, because both are things a person actually writes: an absolute
 * instant ("2026-09-01", "2026-09-01T12:00:00Z") and a relative window
 * ("-24h", "7d", "-2w"). The sign is optional and always means "ago" — nobody
 * asks what changed in the next two days, and silently answering a future
 * window with an empty list would be a lie by omission.
 *
 * Returns null for empty or unparseable input; every caller treats null as
 * "no bound" except the verbs, which refuse rather than quietly widening.
 */
export function parseSince(raw: string, now = new Date()): string | null {
  const s = (raw || "").trim();
  if (!s) return null;
  const rel = s.match(/^-?(\d+)\s*([smhdw])$/i);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const ms =
      unit === "s" ? 1000
      : unit === "m" ? 60_000
      : unit === "h" ? 3_600_000
      : unit === "d" ? 86_400_000
      : 604_800_000; // w
    return new Date(now.getTime() - n * ms).toISOString();
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

/**
 * Today's exact score for every matched file under the scope, in one SQL query.
 *
 * scoreOneFile (storage.ts) computes, per file:
 *
 *     termCount(t) = bodyFreq(t) + (PATH_MATCH_BONUS if t is in the path)
 *     matched      = { t in terms : termCount(t) > 0 }
 *     raw          = SUM over matched of termCount(t)
 *     coverage     = |matched| / totalTerms
 *     score        = raw * coverage * coverage
 *
 * Two things about that formula are easy to get wrong and are reproduced here
 * deliberately. The path bonus is added INTO termCount, so it is part of `raw`
 * and is scaled by coverage² like any other weight. And a term matched ONLY in
 * the path still counts toward `matched`, so a path-only match raises coverage.
 *
 * The UNION ALL + GROUP BY (path, term) is what adds the bonus into the count:
 * a term with a body posting and a path term contributes tf + 5 for that path;
 * a term with only a path term contributes 5, which is > 0, so it is matched.
 * COUNT(*) after the outer GROUP BY path is therefore |matched|.
 *
 * The arithmetic is written as `SUM * (COUNT*1.0/n) * (COUNT*1.0/n)`, not as
 * `SUM*COUNT*COUNT/(n*n)`, so that it is the same IEEE-754 double evaluated in
 * the same left-to-right order as `rawFrequency * coverage * coverage` in JS.
 * Algebraically equal is not good enough when the result is a sort key.
 *
 * Ties break on path ASC. Today's tie order is the fetch pool's completion
 * order, which is not deterministic; this one is.
 *
 * ONE ROUND TRIP (075). The scoring query, the text of the winners, the skip
 * count and the scope's row count all go in a single db.batch(). That is the
 * whole point of the dispatch: D1 is single-threaded per database, and /ro/search
 * runs two scopes at once, so every extra query is ~300 ms of the 1 s budget
 * paid twice. The text rides the score query as a LEFT JOIN onto the `ranked`
 * CTE — a subquery with LIMIT is not flattened into the join, so the join reads
 * at most `limit` mirror rows, not one per candidate.
 *
 * This is a deliberate departure from the letter of the brief, which asked for
 * a second `SELECT path, content FROM texts WHERE path IN (...)`. Same rows,
 * same order, half the round trips; see REPORT.md.
 */
export async function kwIndexScore(
  env: Env,
  terms: string[],
  scope: string,
  skipDirs: string[],
  limit: number,
  since: string | null = null
): Promise<KwScoreResult> {
  const db = env.KWINDEX;
  const marks = terms.map(() => "?").join(", ");
  const sc = scopeFilter(scope, "f.");
  const sk = skipDirs.length ? skipFilter(skipDirs, "f.") : { sql: "", binds: [] };
  const si = sinceFilter(since, "f.");

  const sql =
    `WITH hits AS (
       SELECT path, term, SUM(tf) AS tc FROM (
         SELECT path, term, tf FROM postings WHERE term IN (${marks})
         UNION ALL
         SELECT path, term, ${PATH_MATCH_BONUS} AS tf FROM pathterms WHERE term IN (${marks})
       ) GROUP BY path, term
     ),
     ranked AS (
       SELECT h.path AS path,
              SUM(h.tc) * (COUNT(*) * 1.0 / ?) * (COUNT(*) * 1.0 / ?) AS score
       FROM hits h
       JOIN files f ON f.path = h.path
       WHERE 1 = 1${sc.sql}${sk.sql}${si.sql}
       GROUP BY h.path
       ORDER BY score DESC, h.path ASC
       LIMIT ?
     )
     SELECT r.path AS path,
            r.score AS score,
            CASE WHEN t.bytes <= ? THEN t.content ELSE NULL END AS content
     FROM ranked r
     LEFT JOIN texts t ON t.path = r.path
     ORDER BY r.score DESC, r.path ASC`;

  const scoreStmt = db.prepare(sql).bind(
    ...terms,
    ...terms,
    terms.length,
    terms.length,
    ...sc.binds,
    ...sk.binds,
    ...si.binds,
    limit,
    TEXTS_INLINE_MAX_BYTES
  );

  // The skip count the old code got by walking the R2 listing. Same set: every
  // .md is indexed, hidden paths are excluded from both, and the GLOBs are the
  // same ones the score query filters with.
  const skipCountStmt = skipDirs.length
    ? db
        .prepare(
          `SELECT COUNT(*) AS n FROM files f WHERE 1 = 1${sc.sql} AND (${skipDirs
            .map(() => "f.path GLOB ?")
            .join(" OR ")})`
        )
        .bind(...sc.binds, ...skipDirs.map((d) => `*/${d}/*`))
    : null;

  const scopeCountStmt = db
    .prepare(`SELECT COUNT(*) AS n FROM files f WHERE 1 = 1${sc.sql}`)
    .bind(...sc.binds);

  const stmts = skipCountStmt
    ? [scoreStmt, skipCountStmt, scopeCountStmt]
    : [scoreStmt, scopeCountStmt];
  const res = await db.batch(stmts);

  const rows = (res[0].results ?? []) as unknown as KwScoreRow[];
  const num = (i: number): number =>
    Number(((res[i].results?.[0] ?? {}) as { n?: number }).n ?? 0);

  return {
    rows,
    skippedFiles: skipCountStmt ? num(1) : 0,
    scopeFiles: num(stmts.length - 1),
  };
}

export interface KwChangedRow {
  path: string;
  r2_updated_at: string;
}

/**
 * Paths the index has seen change since `since`, newest first — `files` alone,
 * no postings, no mirror, no R2. The change feed the forge polls.
 *
 * It answers for the INDEX, not for R2. A write in the last seconds is missing
 * until its hook lands or the nightly runs; every caller says so in words,
 * because a feed that looks authoritative and is a few seconds behind is worse
 * than one that admits it.
 */
export async function kwChangedSince(
  env: Env,
  since: string,
  scope: string,
  limit: number
): Promise<KwChangedRow[]> {
  const db = env.KWINDEX;
  const sc = scopeFilter(scope, "");
  const res = await db
    .prepare(
      `SELECT path, r2_updated_at FROM files
       WHERE r2_updated_at > ?${sc.sql}
       ORDER BY r2_updated_at DESC, path ASC
       LIMIT ?`
    )
    .bind(since, ...sc.binds, limit)
    .all<KwChangedRow>();
  return res.results ?? [];
}

/** Paths with a mirror row in one room — what the nightly diffs against. */
export async function kwTextPaths(env: Env, room: string): Promise<Set<string>> {
  const db = env.KWINDEX;
  const res = await db
    .prepare("SELECT path FROM texts WHERE room = ?")
    .bind(room)
    .all<{ path: string }>();
  return new Set((res.results ?? []).map((r) => r.path));
}

/** path -> r2_updated_at for every indexed file under the scope. */
export async function kwIndexedUnder(
  env: Env,
  scope: string
): Promise<Map<string, string>> {
  const db = env.KWINDEX;
  const sc = scopeFilter(scope, "");
  const res = await db
    .prepare(`SELECT path, r2_updated_at FROM files WHERE 1 = 1${sc.sql}`)
    .bind(...sc.binds)
    .all<{ path: string; r2_updated_at: string }>();
  const out = new Map<string, string>();
  for (const r of res.results ?? []) out.set(r.path, r.r2_updated_at);
  return out;
}

export interface KwIndexStatus {
  room: string;
  files: number;
  /**
   * Mirror rows for the room. Meant to equal `files`, which is meant to equal
   * a recursive /ro/list walk of .md under the room. null means the `texts`
   * table could not be read at all — migration 0002 unapplied — which is a
   * different fact from "zero rows" and is reported as one.
   */
  texts: number | null;
  terms: number;
  postings: number;
  newest_indexed_at: string | null;
  /** Says which of the numbers above are room-scoped. See the note below. */
  terms_scope: string;
}

/**
 * `files` and `texts` are room-scoped — the instrument compares both to an
 * independent recursive /ro/list walk of .md under the room, so they have to
 * be. files > texts means the mirror has a hole: a file over TEXTS_MAX_BYTES,
 * or a room the 075 first fill has not reached yet.
 *
 * `terms` and `postings` are index-WIDE totals. Scoping them to a room means
 * joining ~600k posting rows against `files` plus a COUNT(DISTINCT term) over
 * the result; the global forms ride the (term, path) primary key instead and
 * keep the route fast enough to be worth calling. `terms_scope` is in the
 * payload so the number is never read as room-local.
 */
export async function kwIndexStatus(env: Env, room: string): Promise<KwIndexStatus> {
  const db = env.KWINDEX;
  const base = [
    db
      .prepare("SELECT COUNT(*) AS n, MAX(indexed_at) AS newest FROM files WHERE room = ?")
      .bind(room),
    db.prepare("SELECT COUNT(DISTINCT term) AS n FROM postings"),
    db.prepare("SELECT COUNT(*) AS n FROM postings"),
  ];
  const textsStmt = db
    .prepare("SELECT COUNT(*) AS n FROM texts WHERE room = ?")
    .bind(room);

  // One batch when the mirror exists. If it does not, the batch fails whole, so
  // the three older counts are re-read on their own rather than turning a route
  // that used to work into a 500 the moment a migration is one step behind.
  let res: D1Result[];
  let texts: number | null;
  try {
    res = await db.batch([...base, textsStmt]);
    texts = Number(((res[3].results?.[0] ?? {}) as { n?: number }).n ?? 0);
  } catch (e) {
    console.error("kwindex: texts count failed (migration 0002 unapplied?):", e);
    res = await db.batch(base);
    texts = null;
  }

  const frow = (res[0].results?.[0] ?? {}) as { n?: number; newest?: string | null };
  const trow = (res[1].results?.[0] ?? {}) as { n?: number };
  const prow = (res[2].results?.[0] ?? {}) as { n?: number };
  return {
    room,
    files: Number(frow.n ?? 0),
    texts,
    terms: Number(trow.n ?? 0),
    postings: Number(prow.n ?? 0),
    newest_indexed_at: frow.newest ?? null,
    terms_scope: "files and texts are room-scoped; terms and postings are index-wide",
  };
}
