/**
 * The Activation Layer -- use-dependent memory strengthening with time decay.
 * Spec: sphinx/notes/activation-layer-spec.md (23 Aug 2026). Built 25 Aug 2026
 * from the forge. Moved from R2 JSON blobs to D1 rows 7 Sep 2026 (dispatch 074).
 *
 * ACT-R base-level activation: A(m) = ln( sum over accesses i of t_i^(-d) ),
 * t_i in days since access (floor 0.02), d = 0.5 (ACT-R default; tune against
 * felt relevance, not theory).
 *
 * THE TWO-TIER LAW (non-negotiable): journals and threads stay immutable.
 * Plasticity lives ONLY here -- ledger, scores, search ranking, dream input.
 *
 * NO SELF-WARMING BY CONSTRUCTION: recordAccess is called ONLY from the MCP
 * tool handlers in index.ts (memory_read, memory_search). The machinery
 * (sweep, graph rebuild, dream, neighbours rebuild) calls storage/extraction
 * functions directly and never touches this module's write path. There is no
 * systemRead flag to get wrong because the recording seam is the tool layer,
 * not the storage layer.
 *
 * STORAGE IS D1 (migration 0003, database `garden-index`, binding env.KWINDEX):
 *
 *   accesses(path, ts, kind)   kind 'direct'  = a counted tool-level access
 *                              kind 'spread'  = a one-hop fractional access,
 *                              every timestamp carrying implicit weight
 *                              SPREAD_WEIGHT (0.3). Two kinds in one table
 *                              rather than two tables: same read, same cap,
 *                              same prune, still auditable by `WHERE kind`.
 *                              NO primary key -- duplicate timestamps for a
 *                              path are real (two calls in one millisecond)
 *                              and a unique constraint would silently eat one.
 *
 *   neighbours(path, neighbour)  top co-occurring neighbour paths, rebuilt
 *                              nightly by the machinery from extraction
 *                              entity overlap. ONE HOP ONLY lives here:
 *                              recordAccess reads this table once per call
 *                              and never recurses.
 *
 * WHY THE MOVE. The blob form was a read-modify-write on one object for the
 * whole garden: ~2.9 s of a 4.0 s MCP keyword search whose own work was 1.1 s,
 * and two sessions in the same second lost one another's accesses. recordAccess
 * is now two D1 round trips -- one neighbour lookup, one batch of INSERTs --
 * and appends never collide.
 *
 * THE LEGACY BLOBS. meta/activation/{ledger,spread,neighbours}.json are LEFT IN
 * PLACE by /migrate-activation and are never read after the switch. They are
 * the rollback: redeploy the previous worker and they are live again.
 *
 * DROPPABLE, STILL. Everything here is derived: if a write fails, the read it
 * was counting still succeeds, and if a read fails a warm search degrades to
 * cold. Nothing in this module may throw into a verb.
 */

import type { Env } from "./types";
import { decrypt } from "./crypto";
import { listExtractions, readExtraction } from "./extraction";

// Legacy R2 keys -- read ONCE by migrateActivationToD1, never after.
const LEDGER_KEY = "meta/activation/ledger.json";
const SPREAD_KEY = "meta/activation/spread.json";
const NEIGHBOURS_KEY = "meta/activation/neighbours.json";

export const DECAY = 0.5; // ACT-R default d
export const SPREAD_WEIGHT = 0.3; // fractional access weight, one hop
export const ACTIVATION_BLEND = 0.2; // warm search: 80/20 relevance/activation
const CAP = 50; // timestamps kept per path: first-ever + newest 49
const FLOOR_DAYS = 0.02; // avoid div-by-zero on same-minute hits
const NEIGHBOURS_PER_PATH = 3;
const MIN_SHARED_ENTITIES = 2;

/**
 * D1 allows at most 100 bound parameters per statement
 * (developers.cloudflare.com/d1/platform/limits/). An `accesses` row binds 3
 * (path, ts, kind), a `neighbours` row binds 2, a rowid or a path in an
 * IN-list binds 1 -- so the multi-row statements are chunked at 30 / 45 / 90,
 * ninety parameters each, ten under the wall. Statements are then grouped into
 * batches of 50, the same shape kwindex.ts uses.
 */
const D1_MAX_BOUND_PARAMS = 100;
const ACCESS_ROWS_PER_STMT = Math.floor((D1_MAX_BOUND_PARAMS - 10) / 3); // 30
const NEIGHBOUR_ROWS_PER_STMT = Math.floor((D1_MAX_BOUND_PARAMS - 10) / 2); // 45
const IDS_PER_STMT = D1_MAX_BOUND_PARAMS - 10; // 90
const STMTS_PER_BATCH = 50;

/** Rows the nightly prune will delete in one pass. Bounded on purpose: a prune
 *  that tries to fix everything in one statement is a prune that times out and
 *  fixes nothing. Whatever is left is taken by the next night. */
const PRUNE_MAX_ROWS = 5000;

export type Ledger = Record<string, number[]>;

interface AccessRow {
  path: string;
  ts: number;
}

// ---------------------------------------------------------------------------
// Reads -- {path: number[]}, the same shape every caller has always had
// ---------------------------------------------------------------------------

function chunkedBatches(stmts: D1PreparedStatement[]): D1PreparedStatement[][] {
  const out: D1PreparedStatement[][] = [];
  for (let i = 0; i < stmts.length; i += STMTS_PER_BATCH) {
    out.push(stmts.slice(i, i + STMTS_PER_BATCH));
  }
  return out;
}

/**
 * The per-path cap, applied on READ. Exactly what appendCapped() did on write
 * in the blob era: keep the FIRST-EVER access as t_0 -- it is what makes a
 * long-held memory outrank a burst -- then the newest CAP-1. Not "the last
 * CAP": that quietly drops t_0 and changes every activation score.
 *
 * Applying it here (rather than only at write) means the answer is right the
 * moment the rows land, and pruneAccesses() only has to keep the table small,
 * not keep it correct.
 */
function capTimes(t: number[]): number[] {
  if (t.length <= CAP) return t;
  return [t[0], ...t.slice(t.length - (CAP - 1))];
}

/** Rows in (path, ts) order -> {path: [ts, ...]} ascending, capped. */
function foldAccessRows(rows: AccessRow[]): Ledger {
  const out: Ledger = {};
  for (const r of rows) {
    const list = out[r.path];
    if (list) list.push(Number(r.ts));
    else out[r.path] = [Number(r.ts)];
  }
  for (const p of Object.keys(out)) out[p] = capTimes(out[p]);
  return out;
}

export async function readLedger(env: Env): Promise<Ledger> {
  try {
    const res = await env.KWINDEX.prepare(
      "SELECT path, ts FROM accesses WHERE kind = ? ORDER BY path, ts"
    )
      .bind("direct")
      .all<AccessRow>();
    return foldAccessRows(res.results ?? []);
  } catch (e) {
    // A missing binding, an unapplied 0003, a D1 blip: a warm search degrades
    // to cold, exactly as a missing ledger.json did. Never throws.
    console.error("readLedger unavailable, activation is cold:", e);
    return {};
  }
}

export async function readSpread(env: Env): Promise<Ledger> {
  try {
    const res = await env.KWINDEX.prepare(
      "SELECT path, ts FROM accesses WHERE kind = ? ORDER BY path, ts"
    )
      .bind("spread")
      .all<AccessRow>();
    return foldAccessRows(res.results ?? []);
  } catch (e) {
    console.error("readSpread unavailable, spread is cold:", e);
    return {};
  }
}

// ---------------------------------------------------------------------------
// Recording accesses (called ONLY from MCP tool handlers)
// ---------------------------------------------------------------------------

function countable(path: string): boolean {
  return (
    !!path &&
    !path.startsWith("shared/staging/") &&
    !path.startsWith("meta/") &&
    path.endsWith(".md")
  );
}

/**
 * Record a counted access for each path. Direct hits become 'direct' rows; each
 * hit then warms its top graph neighbours by one hop as 'spread' rows.
 *
 * TWO ROUND TRIPS, NO READ-MODIFY-WRITE. One neighbour lookup, one batch of
 * multi-row INSERTs. The ledger is never read here -- appending a row does not
 * require knowing what is already there, which is the whole point of the move:
 * two sessions recording in the same millisecond both land.
 *
 * The neighbour lookup is a single batch() even when it needs several
 * statements (top_k is capped at 10, so in practice it is one statement of at
 * most ten binds; the chunking is the guard, not the case).
 *
 * Never throws: accesses are droppable, memories are not.
 */
export async function recordAccess(env: Env, paths: string[]): Promise<void> {
  try {
    const counted = [...new Set(paths.filter(countable))];
    if (counted.length === 0) return;
    const now = Date.now();
    const db = env.KWINDEX;

    // Round trip 1: the one-hop neighbour map, for exactly these paths.
    const lookups: D1PreparedStatement[] = [];
    for (let i = 0; i < counted.length; i += IDS_PER_STMT) {
      const chunk = counted.slice(i, i + IDS_PER_STMT);
      const marks = chunk.map(() => "?").join(", ");
      lookups.push(
        db
          .prepare(
            "SELECT path, neighbour FROM neighbours WHERE path IN (" + marks + ")"
          )
          .bind(...chunk)
      );
    }
    const found = await db.batch<{ path: string; neighbour: string }>(lookups);

    const directSet = new Set(counted);
    const toWarm = new Set<string>();
    for (const part of found) {
      for (const row of part.results ?? []) {
        if (!directSet.has(row.neighbour) && countable(row.neighbour)) {
          toWarm.add(row.neighbour);
        }
      }
    }

    // Round trip 2: one batch of multi-row INSERTs. Same countable() /
    // directSet exclusion as the blob era -- a path warmed directly is never
    // also warmed by spread in the same call.
    const groups: Array<[string, string[]]> = [
      ["direct", counted],
      ["spread", [...toWarm]],
    ];
    const writes: D1PreparedStatement[] = [];
    for (const [kind, list] of groups) {
      for (let i = 0; i < list.length; i += ACCESS_ROWS_PER_STMT) {
        const chunk = list.slice(i, i + ACCESS_ROWS_PER_STMT);
        const binds: unknown[] = [];
        for (const p of chunk) binds.push(p, now, kind);
        writes.push(
          db
            .prepare(
              "INSERT INTO accesses (path, ts, kind) VALUES " +
                chunk.map(() => "(?, ?, ?)").join(", ")
            )
            .bind(...binds)
        );
      }
    }
    if (writes.length > 0) await db.batch(writes);
  } catch (e) {
    console.error("recordAccess dropped (memories intact):", e);
  }
}

/**
 * memory_move carries the grooves: same file, same history.
 *
 * OR REPLACE on the two `neighbours` updates because that table has
 * PRIMARY KEY(path, neighbour): if some path already listed BOTH `from` and
 * `to` as neighbours, a plain UPDATE would abort the whole batch on the
 * constraint and the accesses would not carry either. REPLACE folds the pair
 * onto the surviving row, which is what a rename means, and the table is
 * rebuilt from scratch nightly anyway.
 */
export async function carryPath(
  env: Env,
  from: string,
  to: string
): Promise<void> {
  try {
    const db = env.KWINDEX;
    await db.batch([
      db.prepare("UPDATE accesses SET path = ? WHERE path = ?").bind(to, from),
      db
        .prepare("UPDATE OR REPLACE neighbours SET path = ? WHERE path = ?")
        .bind(to, from),
      db
        .prepare(
          "UPDATE OR REPLACE neighbours SET neighbour = ? WHERE neighbour = ?"
        )
        .bind(to, from),
    ]);
  } catch (e) {
    console.error("carryPath dropped:", e);
  }
}

// ---------------------------------------------------------------------------
// Scoring (pure, lazy, never stored)
// ---------------------------------------------------------------------------

export function activationOf(
  direct: number[] | undefined,
  spread: number[] | undefined,
  now: number
): number {
  let sum = 0;
  for (const t of direct ?? []) {
    const days = Math.max((now - t) / 86400000, FLOOR_DAYS);
    sum += Math.pow(days, -DECAY);
  }
  for (const t of spread ?? []) {
    const days = Math.max((now - t) / 86400000, FLOOR_DAYS);
    sum += SPREAD_WEIGHT * Math.pow(days, -DECAY);
  }
  return sum > 0 ? Math.log(sum) : -Infinity; // never accessed: below everything
}

/** Activation for every path that has any history (or a given subset). */
export async function computeActivations(
  env: Env,
  onlyPaths?: string[]
): Promise<Record<string, number>> {
  const [ledger, spread] = await Promise.all([readLedger(env), readSpread(env)]);
  const now = Date.now();
  const paths = onlyPaths ?? [
    ...new Set([...Object.keys(ledger), ...Object.keys(spread)]),
  ];
  const out: Record<string, number> = {};
  for (const p of paths) out[p] = activationOf(ledger[p], spread[p], now);
  return out;
}

/** Percentile label within a set of finite activations. */
export function temperatureLabel(
  a: number,
  allFinite: number[]
): "hot" | "warm" | "cold" {
  if (!isFinite(a) || allFinite.length === 0) return "cold";
  const below = allFinite.filter((x) => x < a).length;
  const pct = below / allFinite.length;
  return pct >= 2 / 3 ? "hot" : pct >= 1 / 3 ? "warm" : "cold";
}

// ---------------------------------------------------------------------------
// Neighbours map (machinery; rebuilt nightly; the one-hop boundary)
// ---------------------------------------------------------------------------

/**
 * Rebuild the `neighbours` table from extraction entity overlap. Returns the
 * number of paths that got at least one neighbour -- the number the nightly
 * line prints -- and throws on D1 trouble so the nightly can say
 * "neighbours FAILED", exactly as when this wrote neighbours.json.
 *
 * DELETE-then-INSERT rather than a diff: the map is small, wholly derived, and
 * a stale neighbour is worse than a missing one. If a later batch fails
 * mid-rebuild the table is short until tomorrow night; spread thins, nothing
 * breaks, and the failure is in the nightly line.
 */
export async function rebuildNeighbours(env: Env): Promise<number> {
  const jsonPaths = await listExtractions(env);
  const entitySets: Record<string, Set<string>> = {};
  for (const jp of jsonPaths) {
    const sourcePath = jp.replace(/\.json$/i, ".md");
    const ex = await readExtraction(env, sourcePath);
    if (!ex?.entities?.length) continue;
    entitySets[sourcePath] = new Set(
      ex.entities.map((e) => e.name.toLowerCase())
    );
  }
  const paths = Object.keys(entitySets);
  const map: Record<string, string[]> = {};
  for (const p of paths) {
    const scored: Array<[string, number]> = [];
    for (const q of paths) {
      if (q === p) continue;
      let shared = 0;
      for (const e of entitySets[p]) if (entitySets[q].has(e)) shared++;
      if (shared >= MIN_SHARED_ENTITIES) scored.push([q, shared]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    if (scored.length > 0) {
      map[p] = scored.slice(0, NEIGHBOURS_PER_PATH).map(([q]) => q);
    }
  }

  const db = env.KWINDEX;
  const pairs: Array<[string, string]> = [];
  for (const p of Object.keys(map)) for (const q of map[p]) pairs.push([p, q]);
  const stmts: D1PreparedStatement[] = [db.prepare("DELETE FROM neighbours")];
  for (let i = 0; i < pairs.length; i += NEIGHBOUR_ROWS_PER_STMT) {
    const chunk = pairs.slice(i, i + NEIGHBOUR_ROWS_PER_STMT);
    const binds: unknown[] = [];
    for (const [p, q] of chunk) binds.push(p, q);
    stmts.push(
      db
        .prepare(
          "INSERT OR REPLACE INTO neighbours (path, neighbour) VALUES " +
            chunk.map(() => "(?, ?)").join(", ")
        )
        .bind(...binds)
    );
  }
  for (const batch of chunkedBatches(stmts)) await db.batch(batch);
  return Object.keys(map).length;
}

/**
 * The bound on `accesses`. capTimes() already makes the READ correct at any
 * table size; this is what stops the table itself from growing forever.
 *
 * Deletes rows that capTimes() would discard anyway: everything that is
 * neither the first-ever access for its (path, kind) nor among the newest
 * CAP-1. Bounded at PRUNE_MAX_ROWS per run and issued as chunked
 * DELETE ... WHERE rowid IN (...) so no single statement is unbounded either.
 * Returns the number of rows removed. Called by the nightly.
 */
export async function pruneAccesses(env: Env): Promise<number> {
  const db = env.KWINDEX;
  const doomed = await db
    .prepare(
      "SELECT rid FROM (SELECT rowid AS rid," +
        " ROW_NUMBER() OVER (PARTITION BY path, kind ORDER BY ts ASC, rowid ASC) AS rn," +
        " COUNT(*) OVER (PARTITION BY path, kind) AS c" +
        " FROM accesses) WHERE rn > 1 AND rn <= c - ? LIMIT ?"
    )
    .bind(CAP - 1, PRUNE_MAX_ROWS)
    .all<{ rid: number }>();
  const ids = (doomed.results ?? []).map((r) => r.rid);
  if (ids.length === 0) return 0;
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += IDS_PER_STMT) {
    const chunk = ids.slice(i, i + IDS_PER_STMT);
    stmts.push(
      db
        .prepare(
          "DELETE FROM accesses WHERE rowid IN (" +
            chunk.map(() => "?").join(", ") +
            ")"
        )
        .bind(...chunk)
    );
  }
  for (const batch of chunkedBatches(stmts)) await db.batch(batch);
  return ids.length;
}

// ---------------------------------------------------------------------------
// One-shot migration: the three R2 blobs -> D1 rows
// ---------------------------------------------------------------------------

/** Legacy blob reader. Used by migrateActivationToD1 and by nothing else. */
async function readJson<T>(env: Env, key: string, fallback: T): Promise<T> {
  try {
    const obj = await env.GARDEN_BUCKET.get(key);
    if (!obj) return fallback;
    const json = await decrypt(await obj.arrayBuffer(), env.ENCRYPTION_KEY);
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export interface ActivationMigration {
  ledger_paths: number;
  ledger_rows: number;
  spread_paths: number;
  spread_rows: number;
  neighbours: number;
  /** Blob keys whose array was empty: they CANNOT survive as rows (no row, no
   *  key) and would show up as a C2 parity miss. appendCapped never produced
   *  one, so this should be 0; it is reported rather than assumed. */
  skipped_empty: number;
  /** Blob arrays that were not already ascending. The read returns rows
   *  ORDER BY ts, so for these the migrated array is a SORTED version of the
   *  blob array -- the one case where parity is a re-ordering, not a copy.
   *  Should be 0 (timestamps are pushed in call order). */
  unsorted_paths: number;
  /** Timestamps that were not integers. The column is INTEGER; a non-integer
   *  would be coerced or stored as REAL and would not round-trip. Date.now()
   *  is always an integer, so this should be 0. */
  non_integer_ts: number;
  forced: boolean;
}

function flattenLedger(
  blob: Ledger,
  kind: string,
  rows: Array<[string, number, string]>,
  stats: { skipped_empty: number; unsorted_paths: number; non_integer_ts: number }
): number {
  let paths = 0;
  for (const p of Object.keys(blob)) {
    const times = Array.isArray(blob[p]) ? blob[p] : [];
    if (times.length === 0) {
      stats.skipped_empty++;
      continue;
    }
    paths++;
    let ascending = true;
    for (let i = 0; i < times.length; i++) {
      if (i > 0 && times[i] < times[i - 1]) ascending = false;
      if (!Number.isInteger(times[i])) stats.non_integer_ts++;
      rows.push([p, times[i], kind]);
    }
    if (!ascending) stats.unsorted_paths++;
  }
  return paths;
}

/**
 * One-shot: meta/activation/{ledger,spread,neighbours}.json -> D1 rows.
 *
 * Copies the blobs VERBATIM -- including paths that countable() would now
 * reject (meta/, non-.md, staging), because readLedger reports history, not
 * eligibility, and /activation-state must come back identical.
 *
 * Idempotent by refusal: returns {conflict: n} if `accesses` already has rows,
 * unless force, which wipes the table first. The R2 objects are left in place.
 */
export async function migrateActivationToD1(
  env: Env,
  force: boolean
): Promise<ActivationMigration | { conflict: number }> {
  const db = env.KWINDEX;
  const existing = await db
    .prepare("SELECT COUNT(*) AS n FROM accesses")
    .first<{ n: number }>();
  const n = Number(existing?.n ?? 0);
  if (n > 0 && !force) return { conflict: n };

  const [ledger, spread, neighbours] = await Promise.all([
    readJson<Ledger>(env, LEDGER_KEY, {}),
    readJson<Ledger>(env, SPREAD_KEY, {}),
    readJson<Record<string, string[]>>(env, NEIGHBOURS_KEY, {}),
  ]);

  const stats = { skipped_empty: 0, unsorted_paths: 0, non_integer_ts: 0 };
  const rows: Array<[string, number, string]> = [];
  const ledgerPaths = flattenLedger(ledger, "direct", rows, stats);
  const ledgerRows = rows.length;
  const spreadPaths = flattenLedger(spread, "spread", rows, stats);
  const spreadRows = rows.length - ledgerRows;

  const pairs: Array<[string, string]> = [];
  for (const p of Object.keys(neighbours)) {
    for (const q of neighbours[p] ?? []) pairs.push([p, q]);
  }

  const stmts: D1PreparedStatement[] = [
    db.prepare("DELETE FROM accesses"),
    db.prepare("DELETE FROM neighbours"),
  ];
  for (let i = 0; i < rows.length; i += ACCESS_ROWS_PER_STMT) {
    const chunk = rows.slice(i, i + ACCESS_ROWS_PER_STMT);
    const binds: unknown[] = [];
    for (const [p, ts, kind] of chunk) binds.push(p, ts, kind);
    stmts.push(
      db
        .prepare(
          "INSERT INTO accesses (path, ts, kind) VALUES " +
            chunk.map(() => "(?, ?, ?)").join(", ")
        )
        .bind(...binds)
    );
  }
  for (let i = 0; i < pairs.length; i += NEIGHBOUR_ROWS_PER_STMT) {
    const chunk = pairs.slice(i, i + NEIGHBOUR_ROWS_PER_STMT);
    const binds: unknown[] = [];
    for (const [p, q] of chunk) binds.push(p, q);
    stmts.push(
      db
        .prepare(
          "INSERT OR REPLACE INTO neighbours (path, neighbour) VALUES " +
            chunk.map(() => "(?, ?)").join(", ")
        )
        .bind(...binds)
    );
  }
  for (const batch of chunkedBatches(stmts)) await db.batch(batch);

  return {
    ledger_paths: ledgerPaths,
    ledger_rows: ledgerRows,
    spread_paths: spreadPaths,
    spread_rows: spreadRows,
    neighbours: pairs.length,
    skipped_empty: stats.skipped_empty,
    unsorted_paths: stats.unsorted_paths,
    non_integer_ts: stats.non_integer_ts,
    forced: n > 0,
  };
}

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

export async function hottestPaths(
  env: Env,
  n: number
): Promise<Array<{ path: string; a: number }>> {
  const acts = await computeActivations(env);
  return Object.entries(acts)
    .filter(([, a]) => isFinite(a))
    .sort((x, y) => y[1] - x[1])
    .slice(0, n)
    .map(([path, a]) => ({ path, a }));
}

export interface ColdDebt {
  path: string;
  a: number; // -Infinity serialised as very cold
  daysSinceAccess: number | null; // null = never accessed
  openQuestions: string[];
}

/**
 * Coldest paths that still carry open questions: near-zero retrieval for 30+
 * days (including never-accessed) but unresolved threads in their extraction.
 */
export async function coldDebts(env: Env, n: number): Promise<ColdDebt[]> {
  const [ledger, spread] = await Promise.all([readLedger(env), readSpread(env)]);
  const now = Date.now();
  const jsonPaths = await listExtractions(env);
  const debts: ColdDebt[] = [];
  for (const jp of jsonPaths) {
    const sourcePath = jp.replace(/\.json$/i, ".md");
    const direct = ledger[sourcePath] ?? [];
    const lastMs = direct.length ? Math.max(...direct) : null;
    const days = lastMs === null ? null : (now - lastMs) / 86400000;
    if (days !== null && days < 30) continue; // walked recently: not a cold debt
    const ex = await readExtraction(env, sourcePath);
    if (!ex?.openQuestions?.length) continue;
    debts.push({
      path: sourcePath,
      a: activationOf(direct, spread[sourcePath], now),
      daysSinceAccess: days === null ? null : Math.round(days),
      openQuestions: ex.openQuestions.slice(0, 3),
    });
  }
  debts.sort((x, y) => {
    const ax = isFinite(x.a) ? x.a : -1e9;
    const ay = isFinite(y.a) ? y.a : -1e9;
    return ax - ay; // coldest first
  });
  return debts.slice(0, n);
}

/** Vital signs for the nightly health line. */
export async function ledgerVitals(
  env: Env
): Promise<{ paths: number; hits: number; spreadPaths: number; spreadHits: number }> {
  const [ledger, spread] = await Promise.all([readLedger(env), readSpread(env)]);
  const sum = (l: Ledger) =>
    Object.values(l).reduce((acc, t) => acc + t.length, 0);
  return {
    paths: Object.keys(ledger).length,
    hits: sum(ledger),
    spreadPaths: Object.keys(spread).length,
    spreadHits: sum(spread),
  };
}
