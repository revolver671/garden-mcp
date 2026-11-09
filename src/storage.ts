/**
 * The Garden — Storage Layer
 * Encrypted R2 operations for memory files
 *
 * R2 key structure mirrors the garden filesystem:
 *   sphinx/journal/2026-04-01.md
 *   shared/notes/journal-convention.md
 *   brother/fitness/2026-04-05-push.md
 */

import { encrypt, decrypt } from "./crypto";
import { semanticSearch, indexMemoryFile, removeMemoryVectors } from "./embeddings";
import { computeActivations, ACTIVATION_BLEND } from "./activation";
import {
  KW_MAX_QUERY_TERMS,
  PATH_MATCH_BONUS,
  isHiddenPath,
  kwIndexRemove,
  kwIndexRemoveMany,
  kwIndexScore,
  kwIndexAppend,
  kwIndexUpsert,
  kwIndexedUnder,
  kwTextPaths,
  kwTextsUpsert,
  parseQueryTerms,
  parseSince,
  stemTerm,
  tokenize,
} from "./kwindex";
import type { KwScoreResult } from "./kwindex";
import type { Env } from "./types";

// The tokenizer, the stopword list and the path-match weight live in
// kwindex.ts now (dispatch 073): the indexer and the scorer must not be able to
// drift apart, and a second stemTerm is exactly how they would. Re-exported so
// callers that only know storage.ts keep working.
export {
  SEARCH_STOPWORDS,
  PATH_MATCH_BONUS,
  parseQueryTerms,
  parseSince,
  tokenize,
  kwIndexStatus,
  kwChangedSince,
} from "./kwindex";

// --------------------------------------------------------------------------
// Path validation (same rules as original server)
// --------------------------------------------------------------------------

const GARDEN_PREFIX = "memory/"; // All memory files stored under this R2 prefix

// Workouts live INSIDE the memory tree, at memory/brother/workouts/.
//
// They used to sit under a sibling "fitness/" prefix, outside GARDEN_PREFIX
// entirely. That put them outside memory_search (both the keyword scan, which
// walks GARDEN_PREFIX, and the vector index, which is keyed on memory-relative
// paths), outside memory_read/list/str_replace, and outside anything downstream
// that reads the memory tree. The log was being written carefully into a room
// with no doors. Note that the header comment at the top of this file always
// described workouts as living at brother/... — the flat prefix was drift from
// the documented design, not the design.
const FITNESS_DIR = "brother/workouts/";
const LEGACY_FITNESS_PREFIX = "fitness/"; // pre-migration keys; see /migrate-fitness

function validatePath(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (clean.includes("..") || clean.startsWith("~")) {
    throw new Error(`Path rejected: ${path}`);
  }
  return clean;
}

function memoryKey(path: string): string {
  return GARDEN_PREFIX + validatePath(path);
}

// Memory-relative path for a workout file, e.g. 'brother/workouts/2026-08-25-push.md'.
// This is what the vector index is keyed on and what memory_read expects.
function fitnessPath(filename: string): string {
  return FITNESS_DIR + validatePath(filename);
}

function fitnessKey(path: string): string {
  return memoryKey(fitnessPath(path));
}

// --------------------------------------------------------------------------
// Read / Write / Delete
// --------------------------------------------------------------------------

export async function readFile(
  env: Env,
  path: string
): Promise<string | null> {
  const key = memoryKey(path);
  const obj = await env.GARDEN_BUCKET.get(key);
  if (!obj) return null;
  return decrypt(await obj.arrayBuffer(), env.ENCRYPTION_KEY);
}

export async function writeFile(
  env: Env,
  path: string,
  content: string,
  updatedAt = ""
): Promise<boolean> {
  const key = memoryKey(path);
  // One stamp, used for both the R2 object and the index row. A caller that
  // will hook the index itself passes its own so the two records agree; an
  // index row stamped LATER than the object it describes would make the
  // staleness guard blind to the next legitimate write.
  const stamp = updatedAt || new Date().toISOString();
  const encrypted = await encrypt(content, env.ENCRYPTION_KEY);
  await env.GARDEN_BUCKET.put(key, encrypted, {
    customMetadata: {
      updatedAt: stamp,
    },
  });
  // Keyword index AFTER the put succeeds. The file is already safe; an index
  // that fails to update is a staleness the search guard repairs on its next
  // pass, so it is logged and never allowed to fail the verb.
  try {
    await kwIndexUpsert(env, validatePath(path), content, stamp);
  } catch (e) {
    console.error("kwIndexUpsert failed after write (non-fatal, guard repairs):", path, e);
  }
  return true;
}

/**
 * The append path — what memory_append calls.
 *
 * The existing content is passed IN rather than read here: memory_append has to
 * read the file first anyway, because the estate lease gate needs to know
 * whether this append would CREATE a build-state file. Two reads of a 400 KB
 * build-state to save one parameter is not a trade worth making.
 *
 * 767: the R2 write no longer goes through writeFile, and the index hook is
 * kwIndexAppend — ONE pass over the APPENDED text, where the old body ran a
 * full reindex of the combined text (writeFile's hook) and then a second
 * identical one. The R2 put below is byte for byte what writeFile writes —
 * same key, same encrypt, same customMetadata stamp — and that one stamp is
 * what kwIndexAppend writes into the mirror and the receipt, so the files
 * row's r2_updated_at always names the put it describes.
 */
export async function appendFile(
  env: Env,
  path: string,
  newContent: string,
  existing: string | null
): Promise<string> {
  const combined = existing ? existing.trimEnd() + "\n\n" + newContent : newContent;
  const stamp = new Date().toISOString();
  await env.GARDEN_BUCKET.put(
    memoryKey(path),
    await encrypt(combined, env.ENCRYPTION_KEY),
    { customMetadata: { updatedAt: stamp } }
  );
  // The wall on the append path, visibly: an append that skips this hook
  // breaks search for the appended words, not something two callers away.
  // Non-fatal for the same reason as every other index hook — the R2 write
  // already happened, and the nightly guard repairs the index.
  try {
    await kwIndexAppend(env, validatePath(path), newContent, combined, stamp);
  } catch (e) {
    console.error("kwIndexAppend failed after append (non-fatal, guard repairs):", path, e);
  }
  return combined;
}

export async function deleteFile(
  env: Env,
  path: string
): Promise<boolean> {
  const key = memoryKey(path);
  await env.GARDEN_BUCKET.delete(key);
  try {
    await kwIndexRemove(env, validatePath(path));
  } catch (e) {
    console.error("kwIndexRemove failed after delete (non-fatal, guard repairs):", path, e);
  }
  return true;
}

// --------------------------------------------------------------------------
// List (with metadata — size + last modified)
// --------------------------------------------------------------------------

export interface ListEntry {
  name: string;
  isDir: boolean;
  size?: number;
  updatedAt?: string;
}

export async function listPath(
  env: Env,
  path: string
): Promise<ListEntry[]> {
  const clean = path ? validatePath(path) + "/" : "";
  const prefix = GARDEN_PREFIX + clean;

  const listed = await env.GARDEN_BUCKET.list({
    prefix,
    delimiter: "/",
  });

  const entries: ListEntry[] = [];

  // Directories (common prefixes)
  for (const prefix of listed.delimitedPrefixes) {
    const name = prefix.replace(GARDEN_PREFIX + clean, "").replace(/\/$/, "");
    if (name && !name.startsWith(".")) {
      entries.push({ name, isDir: true });
    }
  }

  // Files
  for (const obj of listed.objects) {
    const name = obj.key.replace(GARDEN_PREFIX + clean, "");
    if (name && !name.startsWith(".") && !name.includes("/")) {
      entries.push({
        name,
        isDir: false,
        size: obj.size,
        updatedAt: obj.customMetadata?.updatedAt || obj.uploaded.toISOString(),
      });
    }
  }

  // Sort: directories first, then files, alphabetically
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return entries;
}

// --------------------------------------------------------------------------
// Search — a D1 inverted index plus a D1 text mirror (src/kwindex.ts)
//
// WHAT REPLACED WHAT. 073 replaced a full R2 scan (~285 gets, 17-19 s over
// `athena`, Cloudflare 1102 about one call in three) with an inverted index in
// D1. 075 removes the two R2 round trips 073 left behind.
//
// A search costs, on the index path:
//   1 D1 batch — the scoring query WITH the winners' text, the skip count and
//                the scope's row count, in one round trip
//   0 R2 list  — none. Statically checked; see accept_075.py C8.
//   0 R2 gets  — unless a top-K path has no mirror row, which costs exactly one
//                get for that one file and repairs the row in passing.
//
// WHERE THE STALENESS GUARD WENT (075). It listed R2 on every search to find
// files newer than the index, and that list was 1.2-2.0 s of a 1.8-2.7 s
// search. It has moved to kwReconcileRoom, the 15:30 UTC nightly, which does
// the same list-diff per room once a day and repairs both tables.
//
// The property that replaces it: A SEARCH REFLECTS THE INDEX, NOT R2. Every
// write verb below hooks kwIndexUpsert, which writes postings and mirror in one
// batch, so a file written through the verb layer is searchable at its new text
// immediately. A write that reaches GARDEN_BUCKET.put some other way is
// invisible to search until the nightly or /reindex-keywords lands it. That is
// the trade, made on purpose, and it is what accept_075.py P1 plants.
//
// The snippet still never comes from the postings — matchLine and its line
// number are computed by bestLineFor over the file's whole text, exactly as
// before. The only change is where that text is read from: `texts`, which the
// same hook wrote from the same string that was encrypted into R2.
// --------------------------------------------------------------------------

export interface SearchResult {
  path: string;
  matchLine: string;
  /** 1-indexed line number of matchLine, for ranged memory_read follow-up. */
  line: number;
}

const MAX_SEARCH_RESULTS = 20;

interface ScoredResult extends SearchResult {
  score: number;
}

// Directories a keyword scan skips unless the caller asks for them.
// `briefs/` (118 files on 6 Sep 2026, +~10/day) and `archive/` (15) are
// roughly half the round trips under `athena/`. The skip is never silent: the
// count is returned and the verbs print it, with include_all=true as the one
// call widening. Frozen records like build-state.md are NOT skipped: they hold
// the reasons for rulings.
//
// Since 073 the skip is a SEARCH filter, not an INDEX filter. Every .md is
// indexed — /kwindex-status has to be able to match an independent /ro/list
// walk — and the filter is applied in SQL (`path NOT GLOB '*/briefs/*'`, see
// kwindex.ts) so the skipped files never enter the ranking.
export const SKIPPED_SEARCH_DIRS = ["briefs", "archive"];

export interface KeywordSearchOptions {
  includeAll?: boolean;
  /**
   * Cap on results returned (<= MAX_SEARCH_RESULTS). It is the SQL LIMIT now,
   * so it caps the text the mirror hands back as well as the list length: a
   * caller that will only print 5 should say so. Order is unaffected: the first
   * N of a longer list.
   */
  limit?: number;
  /**
   * Only files whose R2 timestamp is newer than this. ISO 8601 ("2026-09-01",
   * "2026-09-01T12:00:00Z") or a relative window ("-24h", "7d"); see parseSince.
   * Unparseable input is treated as no bound by this layer — the VERBS refuse
   * it, because a search that silently widens a window a caller asked to narrow
   * is a wrong answer that looks right.
   */
  since?: string;
}

export interface KeywordSearchDetail {
  results: SearchResult[];
  skippedFiles: number; // files under SKIPPED_SEARCH_DIRS not searched
  /**
   * Changed files a per-call repair budget did not reach. Always 0 since 075:
   * the search does not repair anything any more, the nightly does. Kept in the
   * shape (and in skipNote) because it is the honest place to report a backlog
   * if one is ever measured here again.
   */
  staleFiles: number;
}

function isSkippedPath(rel: string): boolean {
  const segs = rel.split("/");
  // segs[0] is the room (athena, luma, ...); a skipped dir anywhere after it
  return segs.slice(1, -1).some((s) => SKIPPED_SEARCH_DIRS.includes(s));
}

// Six workers, matching the Workers simultaneous-connection cap; more would
// only queue. Used by the fallback scan and by the mirror-miss repair, which
// on a healthy index has nothing to do.
const SEARCH_CONCURRENCY = 6;

// Files a fallback scan indexes in passing. Bounded so one search cannot spend
// the invocation's whole subrequest allowance on repair work.
const SCAN_FILL_BUDGET = 30;

async function pool<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const run = async () => {
    while (next < items.length) await worker(items[next++]);
  };
  await Promise.all(
    Array.from({ length: Math.min(SEARCH_CONCURRENCY, items.length) }, run)
  );
}

/**
 * Every .md under the scope with its R2 timestamp. One list call per 1000 keys
 * and no gets — this is the cheap half of what the old scan did, and it is the
 * only thing that knows the truth about what exists.
 */
async function listScopeMd(env: Env, scope: string): Promise<Map<string, string>> {
  const scopeClean = scope ? validatePath(scope) + "/" : "";
  const prefix = GARDEN_PREFIX + scopeClean;
  const out = new Map<string, string>();
  let cursor: string | undefined;
  do {
    // `include` is a runtime option (customMetadata is returned only when
    // asked for); the repo's R2 typings predate it, hence the cast.
    const listed = await env.GARDEN_BUCKET.list({
      prefix,
      cursor,
      include: ["customMetadata"],
    } as R2ListOptions);
    for (const obj of listed.objects) {
      if (!obj.key.endsWith(".md")) continue;
      const rel = obj.key.replace(GARDEN_PREFIX, "");
      if (isHiddenPath(rel)) continue;
      out.set(rel, obj.customMetadata?.updatedAt || obj.uploaded.toISOString());
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return out;
}

/** Get + decrypt one memory file, with the timestamp R2 holds for it. Null when
 * missing or undecryptable — the scan skipped those silently and so does this. */
async function readDecryptedStamped(
  env: Env,
  rel: string
): Promise<{ content: string; updatedAt: string } | null> {
  try {
    const obj = await env.GARDEN_BUCKET.get(GARDEN_PREFIX + rel);
    if (!obj) return null;
    return {
      content: await decrypt(await obj.arrayBuffer(), env.ENCRYPTION_KEY),
      updatedAt: obj.customMetadata?.updatedAt || obj.uploaded.toISOString(),
    };
  } catch {
    return null;
  }
}

/** readDecryptedStamped without the stamp, for callers that already have one. */
async function readDecrypted(env: Env, rel: string): Promise<string | null> {
  const r = await readDecryptedStamped(env, rel);
  return r === null ? null : r.content;
}

/**
 * Best preview line: the one containing the most distinct query terms. Strictly
 * greater, starting from -1, so the FIRST line wins a tie — including the
 * zero-hit tie, which is why a path-only match previews line 1.
 */
export function bestLineFor(
  content: string,
  terms: string[]
): { matchLine: string; line: number } {
  let bestLine = "";
  let bestLineNo = 1;
  let bestLineTerms = -1;
  const contentLines = content.split("\n");
  for (let li = 0; li < contentLines.length; li++) {
    const line = contentLines[li];
    const lineTerms = new Set(tokenize(line).map(stemTerm));
    let hits = 0;
    for (const term of terms) {
      if (lineTerms.has(term)) hits++;
    }
    if (hits > bestLineTerms) {
      bestLineTerms = hits;
      bestLine = line;
      bestLineNo = li + 1;
    }
  }
  return { matchLine: bestLine.trim().slice(0, 100), line: bestLineNo };
}

/**
 * Score one file's decrypted text. This is the definition the SQL in
 * kwIndexScore reproduces; if the two ever disagree, this one is right and the
 * SQL is the bug. Returns null when the file matches nothing.
 *
 * Note the two subtleties the SQL has to copy: the path bonus is added INTO the
 * term's count, so it is part of rawFrequency and gets scaled by coverage²; and
 * a term found only in the path still increments matchedTerms, so it raises
 * coverage.
 */
export function scoreOneFile(
  relPath: string,
  content: string,
  terms: string[],
  totalTerms: number
): ScoredResult | null {
  // Term frequencies in the body.
  const bodyFreq = new Map<string, number>();
  for (const token of tokenize(content)) {
    const stemmed = stemTerm(token);
    bodyFreq.set(stemmed, (bodyFreq.get(stemmed) || 0) + 1);
  }

  // Terms present in the file path (title/name matching).
  const pathTerms = new Set(tokenize(relPath).map(stemTerm));

  let rawFrequency = 0;
  let matchedTerms = 0;
  for (const term of terms) {
    let termCount = bodyFreq.get(term) || 0;
    if (pathTerms.has(term)) termCount += PATH_MATCH_BONUS;
    if (termCount > 0) {
      matchedTerms++;
      rawFrequency += termCount;
    }
  }

  if (matchedTerms === 0) return null;

  // coverage² so a file hitting every term outranks one that hits a single
  // term many times.
  const coverage = matchedTerms / totalTerms;
  const score = rawFrequency * coverage * coverage;

  const best = bestLineFor(content, terms);
  return { path: relPath, matchLine: best.matchLine, line: best.line, score };
}

/** score DESC, then path ASC. Today's tie order is the fetch pool's completion
 * order and is not deterministic; this one is. Plain < / > on the string, not
 * localeCompare, so JS agrees with SQLite's BINARY collation. */
function byScoreThenPath(a: ScoredResult, b: ScoredResult): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export async function searchFiles(
  env: Env,
  query: string,
  scope: string,
  opts: KeywordSearchOptions = {}
): Promise<SearchResult[]> {
  return (await searchFilesDetailed(env, query, scope, opts)).results;
}

export async function searchFilesDetailed(
  env: Env,
  query: string,
  scope: string,
  opts: KeywordSearchOptions = {}
): Promise<KeywordSearchDetail> {
  const terms = parseQueryTerms(query);
  if (terms.length === 0) return { results: [], skippedFiles: 0, staleFiles: 0 };
  const totalTerms = terms.length;
  const limit = Math.max(
    1,
    Math.min(opts.limit ?? MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS)
  );
  const skipDirs = opts.includeAll ? [] : SKIPPED_SEARCH_DIRS;
  const since = parseSince(opts.since ?? "");

  // (T) Timing (073b, reshaped at 075). One line per search at the end of every
  // path through this function, fallbacks included. Durations only — no paths,
  // no terms, no snippet text ever goes to the tail.
  //
  //   list     R2 list. ZERO on the index path; nonzero means the scan ran.
  //   score    the one D1 batch: scoring query, the winners' text, the two
  //            counts. The mirror read is FOLDED IN HERE — it is the same round
  //            trip, so there is no honest way to bill it separately.
  //   texts    R2 fallback for top-K paths the mirror was missing. Zero on a
  //            whole mirror; `miss` counts the files. This is the number to
  //            watch: it is the mirror telling you it has a hole.
  //   snippets the whole preview pass, bestLineFor included, so it CONTAINS
  //            `texts` rather than sitting beside it.
  const t0 = Date.now();
  let msList = 0;
  let msScore = 0;
  let msTexts = 0;
  let msSnippets = 0;
  let mirrorMiss = 0;
  const logKw = <T>(detail: T, fallback: boolean): T => {
    console.log(
      JSON.stringify({
        kw: "search",
        scope,
        ms: {
          list: msList,
          score: msScore,
          texts: msTexts,
          snippets: msSnippets,
          total: Date.now() - t0,
        },
        miss: mirrorMiss,
        fallback,
      })
    );
    return detail;
  };

  // Whether the index is eligible at all: no binding, or a query too wide for
  // one bound statement, means the scan. Truncating the query would be a wrong
  // answer that looks right.
  const useIndex = !!env.KWINDEX && totalTerms <= KW_MAX_QUERY_TERMS;

  // The fallback. It lists R2 and reads every file, so it lives in its own
  // function: nothing on THIS path may touch an R2 list, and accept_075.py C8
  // checks that statically by reading this function's body.
  const runScan = async (): Promise<KeywordSearchDetail> => {
    const tScan = Date.now();
    const out = await scanAndFill(env, terms, scope, !!opts.includeAll, limit, since);
    msList = out.msList;
    // += so a scan entered because the D1 batch FAILED still shows the time
    // that batch burned before it did. The list is billed to `list`, not twice.
    msScore += Date.now() - tScan - out.msList;
    return logKw(out.detail, true);
  };

  if (!useIndex) return runScan();

  // (1) + (2) One D1 batch. The scoring query is 073's, unchanged in its
  // arithmetic and its tie order, wrapped in a CTE so the winners' text can
  // ride back with them.
  let scored: KwScoreResult;
  const tScore = Date.now();
  try {
    scored = await kwIndexScore(env, terms, scope, skipDirs, limit, since);
  } catch (e) {
    msScore = Date.now() - tScore;
    // Migration unapplied, database unreachable — never a search failure.
    console.error("kwindex: score batch failed, falling back to the scan:", e);
    return runScan();
  }
  msScore = Date.now() - tScore;

  // An index with no rows for this scope is not "no matches", it is "no index".
  // The scan answers it and fills both tables in passing.
  if (scored.scopeFiles === 0) return runScan();

  const top: ScoredResult[] = scored.rows.map((r) => ({
    path: r.path,
    matchLine: "",
    line: 0,
    score: r.score,
  }));
  const mirrored = new Map(scored.rows.map((r) => [r.path, r.content]));

  // (3) Preview. The text is already here for every path with a mirror row, so
  // this is pure CPU. A path WITHOUT one — never indexed since 075, or bigger
  // than the mirror will hold or hand back — costs one R2 get, and the row is
  // repaired in passing so the next search does not pay it again.
  const tSnippets = Date.now();
  await pool(top, async (r) => {
    let content = mirrored.get(r.path) ?? null;
    if (content === null) {
      mirrorMiss++;
      const tMiss = Date.now();
      const got = await readDecryptedStamped(env, r.path);
      msTexts += Date.now() - tMiss;
      if (got === null) {
        r.line = -1; // indexed but gone from R2; drop it, the nightly sweeps it
        return;
      }
      content = got.content;
      try {
        await kwTextsUpsert(env, r.path, got.content, got.updatedAt);
      } catch (e) {
        console.error("kwindex: mirror repair failed (search unaffected):", r.path, e);
      }
    }
    const best = bestLineFor(content, terms);
    r.matchLine = best.matchLine;
    r.line = best.line;
  });
  msSnippets = Date.now() - tSnippets;

  return logKw(
    {
      results: top
        .filter((r) => r.line > 0)
        .map(({ path, matchLine, line }) => ({ path, matchLine, line })),
      skippedFiles: scored.skippedFiles,
      staleFiles: 0,
    },
    false
  );
}

interface ScanOutcome {
  detail: KeywordSearchDetail;
  /** Billed to the timing line's `list`, which is how you tell the paths apart. */
  msList: number;
}

/**
 * The old scan, kept whole: list the scope, then get + decrypt + score every
 * searchable file in it. It is what runs when the index is absent, unmigrated
 * or empty for the scope. It fills BOTH tables as it goes, bounded, so repeated
 * searches converge on a healthy index and a whole mirror without anyone
 * running a route.
 *
 * The R2 list lives HERE and not in searchFilesDetailed, and that is load
 * bearing: the whole point of 075 is that the search path does not list R2, and
 * the instrument checks it by reading searchFilesDetailed's body.
 */
async function scanAndFill(
  env: Env,
  terms: string[],
  scope: string,
  includeAll: boolean,
  limit: number,
  since: string | null
): Promise<ScanOutcome> {
  const tList = Date.now();
  const listing = await listScopeMd(env, scope);
  const msList = Date.now() - tList;

  const searchable: string[] = [];
  let skippedFiles = 0;
  for (const [rel, uploaded] of listing) {
    if (!includeAll && isSkippedPath(rel)) {
      skippedFiles++;
      continue;
    }
    // The scan's `since`: R2's own timestamps, so the two paths mean the same
    // thing by the same clock even though one reads it from D1.
    if (since && !(uploaded > since)) continue;
    searchable.push(rel);
  }

  const totalTerms = terms.length;
  const scored: ScoredResult[] = [];
  let fill = SCAN_FILL_BUDGET;

  await pool([...searchable].sort(), async (rel) => {
    const content = await readDecrypted(env, rel);
    if (content === null) return;
    const r = scoreOneFile(rel, content, terms, totalTerms);
    if (r) scored.push(r);
    if (fill > 0) {
      fill--;
      try {
        await kwIndexUpsert(env, rel, content, listing.get(rel) as string);
      } catch (e) {
        console.error("kwindex: fill upsert failed (search unaffected):", rel, e);
      }
    }
  });

  scored.sort(byScoreThenPath);
  return {
    detail: {
      results: scored
        .slice(0, limit)
        .map(({ path, matchLine, line }) => ({ path, matchLine, line })),
      skippedFiles,
      staleFiles: 0,
    },
    msList,
  };
}

// The line a verb prints when a keyword search did not cover everything. Empty
// when it did.
export function skipNote(skippedFiles: number, staleFiles = 0): string {
  const parts: string[] = [];
  if (skippedFiles > 0) {
    parts.push(
      `${skippedFiles} file(s) under ${SKIPPED_SEARCH_DIRS.map((d) => d + "/").join(" and ")} not searched; pass include_all=true to search them.`
    );
  }
  if (staleFiles > 0) {
    parts.push(
      `${staleFiles} recently-changed file(s) were past this call's reindex budget and were not scored; search again, or POST /reindex-keywords.`
    );
  }
  return parts.length ? `\n(${parts.join(" ")})` : "";
}

// --------------------------------------------------------------------------
// Index maintenance — the routes and the nightly reconciliation
// --------------------------------------------------------------------------

export interface KwReindexPage {
  room: string;
  processed: number;
  nextCursor: string | null;
}

/**
 * One page of a full rebuild: list `batch` objects under the room, read and
 * reindex every .md among them, hand back R2's cursor. The first fill. Files
 * are done one at a time on purpose — the D1 writes serialise anyway and the
 * bound is CPU (tokenising 40 files), not connections.
 *
 * It fills BOTH tables, because it goes through kwIndexUpsert like every write
 * verb does. That is why the 075 deploy re-runs it over all six rooms: the
 * postings from 073 are already correct, but no file has a mirror row yet, and
 * a room whose mirror is empty makes every search pay one R2 get per result
 * until it is full.
 */
export async function kwReindexPage(
  env: Env,
  room: string,
  cursor: string | undefined,
  batch: number
): Promise<KwReindexPage> {
  const prefix = GARDEN_PREFIX + validatePath(room) + "/";
  const listed = await env.GARDEN_BUCKET.list({
    prefix,
    cursor,
    limit: batch,
    include: ["customMetadata"],
  } as R2ListOptions);

  let processed = 0;
  for (const obj of listed.objects) {
    if (!obj.key.endsWith(".md")) continue;
    const rel = obj.key.replace(GARDEN_PREFIX, "");
    if (isHiddenPath(rel)) continue;
    const content = await readDecrypted(env, rel);
    if (content === null) continue;
    await kwIndexUpsert(
      env,
      rel,
      content,
      obj.customMetadata?.updatedAt || obj.uploaded.toISOString()
    );
    processed++;
  }

  return { room, processed, nextCursor: listed.truncated ? listed.cursor : null };
}

export interface KwReconcileSummary {
  room: string;
  files: number;
  stale: number;
  /** Of `stale`: files whose postings were current but whose mirror row was absent. */
  mirrorGaps: number;
  reindexed: number;
  removed: number;
}

/**
 * Nightly reconciliation for one room: list it, compare against the index AND
 * the mirror, reindex up to `budget` files that are stale, unindexed or
 * unmirrored, and drop rows — postings, path terms, mirror, receipt — for files
 * that no longer exist.
 *
 * SINCE 075 THIS IS THE ONLY STALENESS GUARD. Searches used to carry it: every
 * one listed R2 and repaired what it found, which cost 1.2-2.0 s per search to
 * fix something that is almost never broken, because every write verb hooks the
 * index. The work did not get less correct by moving here; it got less
 * frequent. What it costs is a window: a write that bypasses the verb layer is
 * not searchable until this runs (or until someone calls /reindex-keywords).
 *
 * NOT a blind first page of a rebuild. A nightly that always reindexes objects
 * 1-40 of a room re-does the same forty files every night and never reaches
 * file 41; this one always works on exactly what is wrong, so it converges.
 * The blind paginated rebuild is /reindex-keywords, which is the right shape
 * for a first fill because it is driven and resumable from outside.
 */
export async function kwReconcileRoom(
  env: Env,
  room: string,
  budget: number
): Promise<KwReconcileSummary> {
  const listing = await listScopeMd(env, room);
  const [indexed, mirrored] = await Promise.all([
    kwIndexedUnder(env, room),
    kwTextPaths(env, room),
  ]);

  // Three ways to be wrong, one repair: kwIndexUpsert rewrites postings, path
  // terms, mirror and receipt together, so a mirror-only gap costs a full
  // reindex of that one file. Cheaper than a second code path that could drift.
  const stale: string[] = [];
  let mirrorGaps = 0;
  for (const [rel, uploaded] of listing) {
    const seen = indexed.get(rel);
    if (seen === undefined || uploaded > seen) {
      stale.push(rel);
    } else if (!mirrored.has(rel)) {
      mirrorGaps++;
      stale.push(rel);
    }
  }
  stale.sort();

  // A row in EITHER table with no R2 object behind it. Union, because a mirror
  // row can outlive its receipt (an upsert that failed between statements).
  const orphans: string[] = [];
  for (const rel of indexed.keys()) if (!listing.has(rel)) orphans.push(rel);
  for (const rel of mirrored) if (!listing.has(rel) && !indexed.has(rel)) orphans.push(rel);
  if (orphans.length) await kwIndexRemoveMany(env, orphans);

  let reindexed = 0;
  for (const rel of stale.slice(0, budget)) {
    const content = await readDecrypted(env, rel);
    if (content === null) continue;
    await kwIndexUpsert(env, rel, content, listing.get(rel) as string);
    reindexed++;
  }

  return {
    room,
    files: listing.size,
    stale: stale.length,
    mirrorGaps,
    reindexed,
    removed: orphans.length,
  };
}

/** Top-level rooms in the garden, for the nightly sweep. */
export async function listRooms(env: Env): Promise<string[]> {
  const listed = await env.GARDEN_BUCKET.list({
    prefix: GARDEN_PREFIX,
    delimiter: "/",
  });
  return listed.delimitedPrefixes
    .map((p) => p.replace(GARDEN_PREFIX, "").replace(/\/$/, ""))
    .filter((n) => n && !n.startsWith("."))
    .sort();
}

// --------------------------------------------------------------------------
// Hybrid search — Reciprocal Rank Fusion of keyword + semantic results
// --------------------------------------------------------------------------

export interface HybridResult {
  path: string;
  score: number;
  snippet: string;
  /** Present only when snippet is the keyword matchLine. */
  line?: number;
}

const RRF_K = 60; // Standard Reciprocal Rank Fusion constant
const VECTOR_FLOOR = 0.45; // Min best cosine to trust the semantic side alone

// Count how many distinct query terms appear in a piece of text.
function distinctTermCount(text: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const present = new Set(tokenize(text).map(stemTerm));
  let n = 0;
  for (const term of terms) {
    if (present.has(term)) n++;
  }
  return n;
}

/**
 * Hybrid search: run keyword (searchFiles) and semantic (semanticSearch) in
 * parallel and fuse with Reciprocal Rank Fusion. RRF is rank-based, so cosine
 * scores and term frequencies never need normalizing against each other —
 * each list votes 1/(k + rank) and shared files sum both votes.
 *
 * Relevance floor: if the best vector cosine is weak AND no keyword result
 * matched 2+ query terms, return empty rather than confident garbage.
 */
export async function hybridSearch(
  env: Env,
  query: string,
  scope: string = "",
  topK: number = 5,
  category?: string,
  after?: string,
  warm: boolean = true,
  opts: KeywordSearchOptions = {}
): Promise<HybridResult[]> {
  return (await hybridSearchDetailed(env, query, scope, topK, category, after, warm, opts)).results;
}

export interface HybridSearchDetail {
  results: HybridResult[];
  skippedFiles: number;
  staleFiles: number;
}

export async function hybridSearchDetailed(
  env: Env,
  query: string,
  scope: string = "",
  topK: number = 5,
  category?: string,
  after?: string,
  warm: boolean = true,
  opts: KeywordSearchOptions = {}
): Promise<HybridSearchDetail> {
  const [kwDetail, vec] = await Promise.all([
    searchFilesDetailed(env, query, scope, opts),
    semanticSearch(env, query, scope || undefined, topK, category, after),
  ]);
  const kwAll = kwDetail.results;
  const skippedFiles = kwDetail.skippedFiles;
  const staleFiles = kwDetail.staleFiles;

  // The keyword side filters by scope (path prefix) but not category — narrow
  // it by the category path segment so both sides agree.
  const kw = category
    ? kwAll.filter((r) => r.path.split("/")[1] === category)
    : kwAll;

  // Relevance floor.
  const terms = parseQueryTerms(query);
  const bestVectorScore = vec.length ? vec[0].score : 0;
  const keywordMatched2Plus = kw.some(
    (r) => distinctTermCount(r.matchLine, terms) >= 2
  );
  if (bestVectorScore < VECTOR_FLOOR && !keywordMatched2Plus) {
    return { results: [], skippedFiles, staleFiles };
  }

  // Reciprocal Rank Fusion.
  const fused = new Map<string, HybridResult>();

  vec.forEach((r, rank) => {
    const entry = fused.get(r.path) || { path: r.path, score: 0, snippet: r.snippet };
    entry.score += 1 / (RRF_K + rank);
    if (r.snippet) entry.snippet = r.snippet; // prefer the vector snippet
    fused.set(r.path, entry);
  });

  kw.forEach((r, rank) => {
    const entry = fused.get(r.path) || { path: r.path, score: 0, snippet: "" };
    entry.score += 1 / (RRF_K + rank);
    if (!entry.snippet) {
      entry.snippet = r.matchLine; // fall back to keyword line
      entry.line = r.line;
    }
    fused.set(r.path, entry);
  });

  // Warm search (activation layer, 25 Aug 2026): blend RRF relevance with
  // ACT-R activation, 80/20. Relevance stays dominant -- a memory system that
  // only shows you what you already revisit is a rut, not a groove. Blend
  // happens over the WHOLE fused candidate set, before the topK cut, so a
  // recently-walked file just below the cut can surface. warm=false ("cold"
  // mode) is the audit view and the escape hatch: pure RRF, byte-identical
  // to pre-activation behaviour.
  const candidates = [...fused.values()];
  if (warm && candidates.length > 1) {
    try {
      const acts = await computeActivations(
        env,
        candidates.map((c) => c.path)
      );
      const rrfMax = Math.max(...candidates.map((c) => c.score));
      const finite = Object.values(acts).filter((a) => isFinite(a));
      const aMin = finite.length ? Math.min(...finite) : 0;
      const aMax = finite.length ? Math.max(...finite) : 0;
      for (const c of candidates) {
        const rrfN = rrfMax > 0 ? c.score / rrfMax : 0;
        const a = acts[c.path];
        const actN =
          isFinite(a) && aMax > aMin
            ? (a - aMin) / (aMax - aMin)
            : isFinite(a) && finite.length
              ? 1 // sole finite activation among candidates
              : 0; // never-accessed: contributes nothing, ranks by relevance alone
        c.score = (1 - ACTIVATION_BLEND) * rrfN + ACTIVATION_BLEND * actN;
      }
    } catch (e) {
      console.error("warm blend skipped (relevance-only ranking):", e);
    }
  }

  return {
    results: candidates
      .sort((a, b) => b.score - a.score)
      .slice(0, topK),
    skippedFiles,
    staleFiles,
  };
}

// --------------------------------------------------------------------------
// Fitness storage (same encryption, different prefix)
// --------------------------------------------------------------------------

export async function writeFitnessFile(
  env: Env,
  filename: string,
  content: string
): Promise<boolean> {
  const key = fitnessKey(filename);
  const stamp = new Date().toISOString();
  const encrypted = await encrypt(content, env.ENCRYPTION_KEY);
  await env.GARDEN_BUCKET.put(key, encrypted, {
    customMetadata: { updatedAt: stamp },
  });

  // Workouts live inside the memory tree, so they are memory_search results and
  // they belong in the keyword index like anything else. Non fatal, as above.
  try {
    await kwIndexUpsert(env, fitnessPath(filename), content, stamp);
  } catch (e) {
    console.error("kwIndexUpsert failed after workout write (non-fatal):", filename, e);
  }

  // Index on the memory-relative path so memory_search finds the session by
  // what it says, not only by its filename. Non-fatal: a workout that is
  // written but unindexed is recoverable; a write that fails is not.
  try {
    await indexMemoryFile(env, fitnessPath(filename), content);
  } catch (e) {
    console.error("Vector indexing failed after workout write (non-fatal):", e);
  }

  return true;
}

export async function listFitnessFiles(
  env: Env,
  workoutType: string,
  count: number
): Promise<{ name: string; content: string }[]> {
  const prefix = GARDEN_PREFIX + FITNESS_DIR;
  const listed = await env.GARDEN_BUCKET.list({ prefix });

  let files = listed.objects
    .filter((obj) => obj.key.endsWith(".md"))
    .sort((a, b) => b.key.localeCompare(a.key)); // Newest first

  if (workoutType) {
    files = files.filter((f) => f.key.includes(workoutType));
  }

  files = files.slice(0, count);

  const results: { name: string; content: string }[] = [];
  for (const f of files) {
    try {
      const obj = await env.GARDEN_BUCKET.get(f.key);
      if (!obj) continue;
      const content = await decrypt(
        await obj.arrayBuffer(),
        env.ENCRYPTION_KEY
      );
      results.push({
        name: f.key.replace(prefix, ""),
        content,
      });
    } catch {
      continue;
    }
  }

  return results;
}

// Read ONE workout file by name. listFitnessFiles reads the newest N and is the
// wrong instrument when you know the filename — it pulls whole sessions to find
// one. This is the targeted read, and it is what workout_edit is built on.
export async function readFitnessFile(
  env: Env,
  filename: string
): Promise<string | null> {
  const key = fitnessKey(filename);
  const obj = await env.GARDEN_BUCKET.get(key);
  if (!obj) return null;
  return await decrypt(await obj.arrayBuffer(), env.ENCRYPTION_KEY);
}

// Exactly-once edit against a workout file. Mirrors strReplaceFile deliberately:
// same refusals, same wording, so the two verbs fail identically and neither
// needs its own mental model. Since the migration to memory/brother/workouts/
// it also reindexes, exactly as strReplaceFile does.
export async function strReplaceFitnessFile(
  env: Env,
  filename: string,
  oldStr: string,
  newStr: string
): Promise<ReplaceResult> {
  if (!oldStr) throw new Error("old_str must not be empty");

  const content = await readFitnessFile(env, filename);
  if (content === null) throw new Error(`Not found: ${filename}`);

  const count = countOccurrences(content, oldStr);
  if (count === 0) {
    throw new Error(
      `no_match: old_str does not appear in ${filename}. Check whitespace and line breaks.`
    );
  }
  if (count > 1) {
    throw new Error(
      `ambiguous_match: old_str appears ${count} times in ${filename}. ` +
        `Widen it with surrounding context so it matches exactly once.`
    );
  }

  const index = content.indexOf(oldStr);
  const lineNumber = content.slice(0, index).split("\n").length;
  const updated =
    content.slice(0, index) + newStr + content.slice(index + oldStr.length);

  await writeFitnessFile(env, filename, updated);

  return { lineNumber, oldLength: oldStr.length, newLength: newStr.length };
}

// One-shot migration: legacy fitness/*.md -> memory/brother/workouts/*.md.
//
// Byte-level relocation. crypto.ts prepends a random IV and uses no AAD, so the
// R2 key is not bound into the ciphertext and an object can be moved without
// decrypting it. Decryption happens once per file afterwards, only to build the
// vector index on the new path.
//
// Idempotent by construction: a destination that already exists is skipped
// rather than overwritten, so re-running cannot clobber a newer file with an
// older one. Delete of the source happens only after a verified put.
export async function migrateFitnessToMemory(
  env: Env,
  dryRun: boolean
): Promise<{ moved: string[]; skipped: string[]; failed: string[] }> {
  const moved: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  let cursor: string | undefined;
  const keys: string[] = [];
  do {
    const listed = await env.GARDEN_BUCKET.list({
      prefix: LEGACY_FITNESS_PREFIX,
      cursor,
    });
    for (const o of listed.objects) keys.push(o.key);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  for (const oldKey of keys) {
    const filename = oldKey.slice(LEGACY_FITNESS_PREFIX.length);
    if (!filename.endsWith(".md")) {
      skipped.push(`${filename} (not markdown)`);
      continue;
    }
    const newPath = fitnessPath(filename);
    const newKey = memoryKey(newPath);

    try {
      const existing = await env.GARDEN_BUCKET.head(newKey);
      if (existing) {
        skipped.push(`${filename} (destination already exists)`);
        continue;
      }

      const obj = await env.GARDEN_BUCKET.get(oldKey);
      if (!obj) {
        failed.push(`${filename} (source vanished)`);
        continue;
      }
      const bytes = await obj.arrayBuffer();

      if (dryRun) {
        moved.push(`${filename} -> ${newPath} (DRY RUN)`);
        continue;
      }

      await env.GARDEN_BUCKET.put(newKey, bytes, {
        customMetadata: obj.customMetadata ?? {
          updatedAt: new Date().toISOString(),
        },
      });

      // Confirm the destination is readable before removing the source.
      const check = await env.GARDEN_BUCKET.get(newKey);
      if (!check) {
        failed.push(`${filename} (destination unreadable after put; source kept)`);
        continue;
      }
      const content = await decrypt(await check.arrayBuffer(), env.ENCRYPTION_KEY);

      // The destination lands INSIDE the memory tree, so this put is a write
      // to the keyword index like any other, and it is hooked here for the
      // same reason writeFile hooks its own: the wall belongs on every path
      // that reaches GARDEN_BUCKET.put under GARDEN_PREFIX, visibly.
      //
      // Stamp the row from the object that is actually there, the way
      // writeFile does — an index row stamped LATER than the object it
      // describes would make the staleness guard blind to the next
      // legitimate write. Non-fatal: an unindexed destination is a staleness
      // the nightly reconcile repairs, and the file is already safe.
      const stamp =
        check.customMetadata?.updatedAt || check.uploaded.toISOString();
      try {
        await kwIndexUpsert(env, newPath, content, stamp);
      } catch (e) {
        console.error(
          "kwIndexUpsert failed after fitness migration (non-fatal, guard repairs):",
          newPath,
          e
        );
      }

      let vectorNote = "";
      try {
        await indexMemoryFile(env, newPath, content);
      } catch (e) {
        // The move stands; the index can be rebuilt. Name it, don't fail it.
        vectorNote = ` (moved, INDEXING FAILED: ${String(e)})`;
      }

      // Source object gone, and the source's index row with it — R2 first,
      // index after, neither allowed to fail the verb, exactly the order
      // deleteFile uses. Both outcomes above take this path: a file whose
      // vectors failed has still MOVED, and leaving its old row behind would
      // be the same staleness whichever index failed.
      //
      // Be exact about what this removes today. The source sits under
      // LEGACY_FITNESS_PREFIX, a sibling of GARDEN_PREFIX, and every filler of
      // the keyword index walks GARDEN_PREFIX — so the legacy key has no row
      // and this is a no-op against the current tree. It is here so the delete
      // cannot leave a row behind if that stops being true: a hand-run
      // backfill over the wrong prefix, or a later migration whose source IS
      // inside the memory tree. One D1 batch on a one-shot admin route is
      // cheaper than the class of bug it closes, and the wall belongs on every
      // delete visibly rather than resting on an argument about what happens
      // to be indexed.
      await env.GARDEN_BUCKET.delete(oldKey);
      try {
        await kwIndexRemove(env, validatePath(LEGACY_FITNESS_PREFIX + filename));
      } catch (e) {
        console.error(
          "kwIndexRemove failed after fitness migration (non-fatal, guard repairs):",
          filename,
          e
        );
      }

      if (vectorNote) skipped.push(`${filename}${vectorNote}`);
      else moved.push(`${filename} -> ${newPath}`);
    } catch (e) {
      failed.push(`${filename} (${String(e)})`);
    }
  }

  return { moved, skipped, failed };
}

// --------------------------------------------------------------------------
// Move / Copy — byte-level relocation
//
// crypto.ts prepends a random 12-byte IV to the ciphertext and uses no AAD, so
// the R2 key is NOT part of the encryption. Relocating a file is therefore a
// pure byte copy: no decrypt, no re-encrypt. It costs the same at 389 KB as it
// does at 8 KB, which is the whole point — read-whole/retype/delete was
// impossible on the large build-state files.
//
// The vector index is the part that is NOT free. Chunk vector ids are derived
// from the path (`${path}#chunk0`), so a move leaves the semantic index
// pointing at a key that no longer exists. Stale vectors are always deleted.
// Re-embedding under the new path costs one subrequest per chunk against the
// Workers 50-subrequest limit, so it happens inline only under
// MAX_INLINE_REINDEX_BYTES. Above that the move still succeeds and SAYS SO —
// a half-updated index that reports success is the failure worth avoiding.
//
// Keyword search is NOT unaffected — it has not read R2 directly since 073,
// and since 075 it does not read R2 at all on the top-K path. `files`,
// `postings`, `pathterms` and the `texts` mirror are all keyed on the path, so
// a relocation must move four sets of rows or the file goes missing from
// keyword search and from the change feed. relocate itself does not touch D1:
// it hands `fromPath`, `toPath`, `updatedAt` and the decrypted `content` back
// through RelocateInternal, and moveFile (kwIndexRemove + kwIndexUpsert) and
// copyFile (kwIndexUpsert) do the index work after the R2 work has succeeded.
// The decrypt above happens for EVERY size for exactly this reason: the
// MAX_INLINE_REINDEX_BYTES ceiling is a subrequest budget for embedding and it
// governs the vector half only. A 400 KB move skips re-embedding and still
// reindexes keywords in full.
//
// The repair path if a hook fails is the nightly reconcile (kwReconcileRoom),
// not the search itself — 075 moved that guard off the search path.
// --------------------------------------------------------------------------

// ~25 chunks at CHUNK_SIZE 2000, leaving headroom under the 50-subrequest cap.
const MAX_INLINE_REINDEX_BYTES = 50_000;

export interface RelocateResult {
  bytes: number;
  reindexed: boolean;
  reindexNote: string;
}

// What relocate knows and its callers need in order to hook the keyword index:
// where the file landed, when, and what it says. Not part of RelocateResult —
// no verb should return a file's plaintext to its caller by accident.
interface RelocateInternal extends RelocateResult {
  fromPath: string;
  toPath: string;
  updatedAt: string;
  content: string | null;
}

async function relocate(
  env: Env,
  from: string,
  to: string,
  opts: { deleteSource: boolean; overwrite: boolean; preserveTimestamp: boolean }
): Promise<RelocateInternal> {
  const fromKey = memoryKey(from);
  const toKey = memoryKey(to);

  if (fromKey === toKey) {
    throw new Error(`Source and destination are the same path: ${from}`);
  }

  const source = await env.GARDEN_BUCKET.get(fromKey);
  if (!source) throw new Error(`Not found: ${from}`);

  if (!opts.overwrite) {
    const existing = await env.GARDEN_BUCKET.head(toKey);
    if (existing) {
      throw new Error(
        `Destination already exists: ${to} (pass overwrite: true to replace it)`
      );
    }
  }

  const bytes = await source.arrayBuffer();

  // A move keeps the file's identity, so it keeps its timestamp. A copy is a
  // new artifact and is stamped now — otherwise a fresh snapshot would list as
  // older than it is.
  const updatedAt = opts.preserveTimestamp
    ? source.customMetadata?.updatedAt || source.uploaded.toISOString()
    : new Date().toISOString();

  await env.GARDEN_BUCKET.put(toKey, bytes, {
    customMetadata: { updatedAt },
  });

  if (opts.deleteSource) {
    await env.GARDEN_BUCKET.delete(fromKey);
    try {
      await removeMemoryVectors(env, validatePath(from));
    } catch (e) {
      console.error("Vector cleanup failed on move source (non-fatal):", e);
    }
  }

  // The KEYWORD index needs the destination's text whatever the file's size,
  // so the decrypt happens once here and the vector path below reuses it. The
  // 50 KB ceiling is about SUBREQUESTS (one per chunk embedded), which is a
  // different budget from CPU: tokenising 400 KB is cheap, embedding it is not.
  let content: string | null = null;
  try {
    content = await decrypt(bytes, env.ENCRYPTION_KEY);
  } catch (e) {
    console.error("Decrypt failed on relocate destination (non-fatal):", e);
  }

  // Reindex the destination under its new path, budget permitting.
  let reindexed = false;
  let reindexNote = "";

  if (bytes.byteLength <= MAX_INLINE_REINDEX_BYTES) {
    try {
      if (content === null) throw new Error("destination did not decrypt");
      await indexMemoryFile(env, validatePath(to), content);
      reindexed = true;
    } catch (e) {
      console.error("Vector indexing failed on relocate (non-fatal):", e);
      reindexNote =
        "semantic vectors were NOT rebuilt (indexing error) — keyword search still works; run the vector backfill";
    }
  } else {
    reindexNote =
      `semantic vectors were NOT rebuilt — ${bytes.byteLength} bytes exceeds the ` +
      `${MAX_INLINE_REINDEX_BYTES}-byte inline budget (Workers 50-subrequest limit). ` +
      `Keyword search still works; run the vector backfill to restore semantic search`;
  }

  return {
    bytes: bytes.byteLength,
    reindexed,
    reindexNote,
    fromPath: validatePath(from),
    toPath: validatePath(to),
    updatedAt,
    content,
  };
}

export async function moveFile(
  env: Env,
  from: string,
  to: string,
  overwrite = false
): Promise<RelocateResult> {
  const r = await relocate(env, from, to, {
    deleteSource: true,
    overwrite,
    preserveTimestamp: true,
  });
  // A move changes a file's PATH, which changes its path terms and its room —
  // the index has to lose the source and gain the destination, both after the
  // R2 work has succeeded. Non fatal: the guard sweeps an orphaned source row
  // and reindexes an unindexed destination on the next search.
  try {
    await kwIndexRemove(env, r.fromPath);
    if (r.content !== null) {
      await kwIndexUpsert(env, r.toPath, r.content, r.updatedAt);
    }
  } catch (e) {
    console.error("kwIndex update failed after move (non-fatal, guard repairs):", from, to, e);
  }
  return { bytes: r.bytes, reindexed: r.reindexed, reindexNote: r.reindexNote };
}

export async function copyFile(
  env: Env,
  from: string,
  to: string,
  overwrite = false
): Promise<RelocateResult> {
  const r = await relocate(env, from, to, {
    deleteSource: false,
    overwrite,
    preserveTimestamp: false,
  });
  // A copy creates a file, so the index gains one; the source is untouched.
  try {
    if (r.content !== null) {
      await kwIndexUpsert(env, r.toPath, r.content, r.updatedAt);
    }
  } catch (e) {
    console.error("kwIndexUpsert failed after copy (non-fatal, guard repairs):", to, e);
  }
  return { bytes: r.bytes, reindexed: r.reindexed, reindexNote: r.reindexNote };
}

// --------------------------------------------------------------------------
// Ranged read
//
// 1-indexed and inclusive, matching the forge's read_file so the two servers
// answer to the same convention. Both bounds 0 means the whole file, so
// existing callers see byte-identical behaviour.
// --------------------------------------------------------------------------

export interface RangedRead {
  content: string;
  totalLines: number;
  start: number;
  end: number;
  ranged: boolean;
}

export async function readFileRange(
  env: Env,
  path: string,
  startLine = 0,
  endLine = 0
): Promise<RangedRead | null> {
  const content = await readFile(env, path);
  if (content === null) return null;

  const lines = content.split("\n");
  const total = lines.length;

  if (startLine <= 0 && endLine <= 0) {
    return { content, totalLines: total, start: 1, end: total, ranged: false };
  }

  const start = Math.max(1, startLine || 1);
  const end = endLine > 0 ? Math.min(endLine, total) : total;

  if (start > total) {
    throw new Error(
      `start_line ${start} is past the end of the file (${total} lines)`
    );
  }
  if (end < start) {
    throw new Error(`end_line ${end} is before start_line ${start}`);
  }

  return {
    content: lines.slice(start - 1, end).join("\n"),
    totalLines: total,
    start,
    end,
    ranged: true,
  };
}

// --------------------------------------------------------------------------
// Surgical replace
//
// old_str must match EXACTLY ONCE. Zero matches and two-or-more matches are
// both refusals, and the refusal names the count — the caller widens old_str
// rather than guessing which occurrence was meant. This is what lets a
// correction RESOLVE in place instead of stacking as another append.
// --------------------------------------------------------------------------

export interface ReplaceResult {
  lineNumber: number;
  oldLength: number;
  newLength: number;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

export async function strReplaceFile(
  env: Env,
  path: string,
  oldStr: string,
  newStr: string
): Promise<ReplaceResult> {
  if (!oldStr) throw new Error("old_str must not be empty");

  const content = await readFile(env, path);
  if (content === null) throw new Error(`Not found: ${path}`);

  const count = countOccurrences(content, oldStr);
  if (count === 0) {
    throw new Error(
      `no_match: old_str does not appear in ${path}. Check whitespace and line breaks.`
    );
  }
  if (count > 1) {
    throw new Error(
      `ambiguous_match: old_str appears ${count} times in ${path}. ` +
        `Widen it with surrounding context so it matches exactly once.`
    );
  }

  const index = content.indexOf(oldStr);
  const lineNumber = content.slice(0, index).split("\n").length;
  const updated = content.slice(0, index) + newStr + content.slice(index + oldStr.length);

  const stamp = new Date().toISOString();
  await writeFile(env, path, updated, stamp);

  // Same stamp writeFile used, so this is a replacement of identical rows, not
  // a second version. Explicit here for the same reason as in appendFile: the
  // hook is per verb, so a verb that loses it fails on its own.
  try {
    await kwIndexUpsert(env, validatePath(path), updated, stamp);
  } catch (e) {
    console.error("kwIndexUpsert failed after str_replace (non-fatal, guard repairs):", path, e);
  }

  try {
    await indexMemoryFile(env, validatePath(path), updated);
  } catch (e) {
    console.error("Vector indexing failed after str_replace (non-fatal):", e);
  }

  return { lineNumber, oldLength: oldStr.length, newLength: newStr.length };
}

// --------------------------------------------------------------------------
// Arrival — one-call orientation
// --------------------------------------------------------------------------

export interface ArrivalPayload {
  timeUtc: string;
  timeNz: string;
  journalPath: string;
  journalBytes: number;
  journalContent: string;
  nightlyLogLast: string;
}

export async function buildArrival(
  env: Env,
  voice: string
): Promise<ArrivalPayload> {
  const clean = validatePath(voice);
  const prefix = GARDEN_PREFIX + clean + "/journal/";

  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await env.GARDEN_BUCKET.list({ prefix, cursor });
    for (const obj of listed.objects) {
      if (obj.key.endsWith(".md")) keys.push(obj.key);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  if (keys.length === 0) {
    throw new Error(`No journal entries under ${clean}/journal/ — cannot orient.`);
  }

  // Newest by filename with the .md extension stripped, so
  // 2026-07-14-evening sorts after 2026-07-14, matching write order.
  // Modified dates are not used: the R2 migration reset them wholesale.
  keys.sort((a, b) => {
    const an = a.slice(0, -3);
    const bn = b.slice(0, -3);
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const newestKey = keys[keys.length - 1];

  const obj = await env.GARDEN_BUCKET.get(newestKey);
  if (!obj) {
    throw new Error(`Newest journal ${newestKey} listed but not readable — cannot orient.`);
  }
  const journalContent = await decrypt(
    await obj.arrayBuffer(),
    env.ENCRYPTION_KEY
  );

  // Nightly log health line — a bonus, never a blocker.
  let nightlyLogLast = "no nightly log yet";
  try {
    const nl = await env.GARDEN_BUCKET.get(
      GARDEN_PREFIX + "shared/system/nightly-log.md"
    );
    if (nl) {
      const logText = await decrypt(await nl.arrayBuffer(), env.ENCRYPTION_KEY);
      // Entries are "- <timestamp> ..." list items; headers and the italic
      // preamble are not entries.
      const first = logText
        .split("\n")
        .map((s) => s.trim())
        .find((s) => s.startsWith("- "));
      nightlyLogLast = first ?? "log exists but has no entries yet";
    }
  } catch {
    nightlyLogLast = "nightly log unreadable";
  }

  const now = new Date();
  const timeNz = new Intl.DateTimeFormat("en-NZ", {
    timeZone: "Pacific/Auckland",
    dateStyle: "full",
    timeStyle: "short",
  }).format(now);

  return {
    timeUtc: now.toISOString(),
    timeNz,
    journalPath: newestKey.replace(GARDEN_PREFIX, ""),
    journalBytes: journalContent.length,
    journalContent,
    nightlyLogLast,
  };
}
