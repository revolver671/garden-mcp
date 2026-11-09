/**
 * The Garden — Semantic Vector Search
 * ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
 *
 * Embeddings via Workers AI (@cf/baai/bge-base-en-v1.5, 768 dims) stored in
 * the `garden-memory-vectors` Vectorize index (cosine).
 *
 * Each memory file is chunked, embedded, and upserted. The chunk text (first
 * 400 chars) rides along in vector metadata as `snippet`, so semantic search
 * can return matched context without ever decrypting from R2.
 *
 * Vector ID scheme:
 *   single-chunk file → `path`
 *   multi-chunk file  → `path#chunk0`, `path#chunk1`, …
 *
 * All operations here are best-effort and called from non-fatal try/catch in
 * the storage handlers — a vector failure must never block a write/delete.
 */

import type { Env } from "./types";
import { decrypt } from "./crypto";

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5"; // 768 dims, free tier, native
const MEMORY_PREFIX = "memory/";

const CHUNK_SIZE = 2000; // ~2000 char fallback chunks
const CHUNK_OVERLAP = 200; // 200 char overlap between fallback chunks
const SNIPPET_CHARS = 400; // stored in metadata for read-free previews

export interface SemanticResult {
  path: string;
  score: number;
  snippet: string;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

// Derive scope + category from a memory path, e.g.
//   "sphinx/journal/2026-04-01.md" → { scope: "sphinx", category: "journal" }
function parsePathMeta(path: string): { scope: string; category: string } {
  const parts = path.split("/").filter(Boolean);
  return {
    scope: parts[0] || "",
    category: parts[1] || "",
  };
}

// Sliding-window split for sections with no headers (or oversized sections).
function slidingWindow(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return chunks;
}

// Chunk content: split on '\n## ' headers first; fall back to ~2000-char
// sliding windows. Oversized header sections are further sub-split so no
// single chunk blows past the embedding model's comfort zone.
function chunkContent(content: string): string[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  const sections = /\n## /.test(trimmed)
    ? trimmed.split(/\n(?=## )/).map((s) => s.trim()).filter(Boolean)
    : [trimmed];

  const chunks: string[] = [];
  for (const section of sections) {
    if (section.length <= CHUNK_SIZE) {
      chunks.push(section);
    } else {
      chunks.push(...slidingWindow(section));
    }
  }
  return chunks;
}

// Fast, non-cryptographic fingerprint of a chunk's text (FNV-1a + length).
// Used to skip re-embedding chunks that haven't changed across reindexes.
function chunkHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16) + "-" + text.length;
}

// Run a single text through the embedding model and return the 768-dim vector.
async function embed(env: Env, text: string): Promise<number[]> {
  const resp = await env.AI.run(EMBED_MODEL, { text: [text] });
  const vec = resp?.data?.[0];
  if (!Array.isArray(vec)) {
    throw new Error("Embedding failed: no vector returned");
  }
  return vec as number[];
}

// Vectorize refuses getByIds payloads over 20 ids (VECTOR_GET_ERROR 40007,
// captured by wrangler tail 6 Sep 2026: "max id count is 20, got 37"). The
// unbatched call was caught silently, which emptied the chunk cache for every
// file over ~20 chunks and made each append re-embed the whole file.
const GET_BY_IDS_MAX = 20;

async function getByIdsBatched(env: Env, ids: string[]): Promise<VectorizeVector[]> {
  const out: VectorizeVector[] = [];
  for (let i = 0; i < ids.length; i += GET_BY_IDS_MAX) {
    const got = await env.VECTORIZE.getByIds(ids.slice(i, i + GET_BY_IDS_MAX));
    out.push(...got);
  }
  return out;
}

// Embeds per indexMemoryFile call. Each embed is one subrequest; a Workers
// invocation has a hard per-invocation cap (a 56-chunk write threw "Too many
// subrequests by single Worker invocation", 6 Sep 2026). Chunks past the
// budget are left unembedded AND unreported to Vectorize; the caller gets the
// count and the next pass (a later write, or the nightly reindex) takes the
// next batch, so a large file converges instead of failing whole.
export const MAX_EMBEDS_PER_CALL = 32;

export interface IndexResult {
  total: number;    // chunks in the file
  reused: number;   // cache hits (hash unchanged)
  embedded: number; // embedded this call
  skipped: number;  // changed chunks left for a later pass
}

export function indexNote(r: IndexResult): string {
  return r.skipped > 0
    ? `${r.skipped} of ${r.total} chunk(s) not embedded this call (budget ${MAX_EMBEDS_PER_CALL}); the nightly reindex finishes them`
    : "";
}

// Vector ids. Vectorize caps ids at 64 bytes (VECTOR_UPSERT_ERROR 40008,
// hit by two archive files on 6 Sep 2026). Short paths keep the original
// scheme (`path`, `path#chunkN`) so nothing already stored changes; a path
// that would overflow uses a 16-hex FNV-1a fold of the path instead. The
// full path is always in metadata, which is what search returns.
const VECTOR_ID_MAX = 64;

function pathFold(path: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

function idBase(path: string): string {
  // Longest id the plain scheme can produce for this path: path + "#chunk" + 3 digits.
  const longest = new TextEncoder().encode(path).length + "#chunk".length + 3;
  return longest <= VECTOR_ID_MAX ? path : `~${pathFold(path)}`;
}

export function vectorId(path: string, index: number, total: number): string {
  const base = idBase(path);
  return total === 1 ? base : `${base}#chunk${index}`;
}

// Discover the exact vector IDs currently stored for a path by probing the
// first chunk and reading its `total_chunks` metadata. Returns [] if none.
async function existingChunkIds(env: Env, path: string): Promise<string[]> {
  try {
    const single = vectorId(path, 0, 1);
    const first = vectorId(path, 0, 2);
    const probes = await env.VECTORIZE.getByIds([single, first]);
    for (const v of probes) {
      const total = Number(v.metadata?.total_chunks) || 0;
      if (v.id === single && total <= 1) {
        return [single];
      }
      if (v.id === first && total >= 1) {
        return Array.from({ length: total }, (_, i) => vectorId(path, i, total));
      }
    }
  } catch {
    // Treat probe failures as "nothing stored yet"
  }
  return [];
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

/**
 * Chunk, embed, and upsert a memory file's vectors. On reindex, deletes
 * exactly the previously-stored chunks (discovered via metadata) before
 * upserting the fresh set — no brute-force delete.
 */
export async function indexMemoryFile(
  env: Env,
  path: string,
  content: string
): Promise<IndexResult> {
  const chunks = chunkContent(content);

  // Empty content: clear any stale vectors and stop.
  if (chunks.length === 0) {
    await removeMemoryVectors(env, path);
    return { total: 0, reused: 0, embedded: 0, skipped: 0 };
  }

  // Fetch the prior vectors (with values + chunk_hash) so unchanged chunks can
  // be reused without re-embedding — matters most for memory_append on long
  // journals, where only the tail chunk actually changes. Batched: see
  // getByIdsBatched. A failure here is logged and treated as an empty cache.
  const oldIds = await existingChunkIds(env, path);
  const priorByIndex = new Map<number, { hash: string; values: number[] }>();
  if (oldIds.length > 0) {
    try {
      const existing = await getByIdsBatched(env, oldIds);
      for (const v of existing) {
        const idx = Number(v.metadata?.chunk_index);
        if (Number.isFinite(idx) && v.values) {
          priorByIndex.set(idx, {
            hash: String(v.metadata?.chunk_hash ?? ""),
            values: v.values as number[],
          });
        }
      }
    } catch (e) {
      console.error("Fetching prior vectors for cache check failed:", e);
    }
  }

  const { scope, category } = parsePathMeta(path);
  const updated_at = new Date().toISOString();
  const totalChunks = chunks.length;

  const vectors: VectorizeVector[] = [];
  let reused = 0;
  let embedded = 0;
  let skipped = 0;
  for (let i = 0; i < totalChunks; i++) {
    const chunk = chunks[i];
    const hash = chunkHash(chunk);

    // Cache hit: same chunk index, same hash, and we have the old embedding.
    const prior = priorByIndex.get(i);
    let values: number[];
    if (prior && prior.hash === hash && prior.values.length) {
      values = prior.values;
      reused++;
    } else if (embedded < MAX_EMBEDS_PER_CALL) {
      values = await embed(env, chunk);
      embedded++;
    } else {
      // Over budget: leave this chunk for a later pass. Its old vector (if
      // any) is deleted below only when its id is not in the new set; here the
      // id IS in the new set, so a stale vector for this index survives until
      // the next pass embeds it. Stale-but-present beats absent for search.
      skipped++;
      continue;
    }

    const id = vectorId(path, i, totalChunks);
    vectors.push({
      id,
      values,
      metadata: {
        path,
        scope,
        category,
        updated_at,
        chunk_index: i,
        total_chunks: totalChunks,
        chunk_hash: hash,
        snippet: chunk.slice(0, SNIPPET_CHARS),
      },
    });
  }

  // Delete only stale vectors (old ids no longer present in the new set) —
  // handles single↔multi transitions and shrinking chunk counts. Surviving
  // ids are overwritten by the upsert below.
  const newIdSet = new Set(
    Array.from({ length: totalChunks }, (_, i) => vectorId(path, i, totalChunks))
  );
  const stale = oldIds.filter((id) => !newIdSet.has(id));
  if (stale.length > 0) {
    try {
      await env.VECTORIZE.deleteByIds(stale);
    } catch (e) {
      console.error("Stale vector cleanup failed:", e);
    }
  }

  if (vectors.length > 0) {
    await env.VECTORIZE.upsert(vectors);
  }
  if (skipped > 0) {
    console.warn(`indexMemoryFile ${path}: ${skipped} of ${totalChunks} chunks deferred (budget ${MAX_EMBEDS_PER_CALL})`);
  }
  return { total: totalChunks, reused, embedded, skipped };
}

/**
 * Delete all vectors for a path. Discovers the exact chunk IDs from metadata
 * so we delete precisely what was stored.
 */
export async function removeMemoryVectors(env: Env, path: string): Promise<void> {
  const ids = await existingChunkIds(env, path);
  if (ids.length > 0) {
    await env.VECTORIZE.deleteByIds(ids);
  }
}

// Query Vectorize, falling back to an unfiltered query if the filter targets
// a metadata field that hasn't been given a metadata index (which otherwise
// errors). Post-filtering downstream still enforces the constraints either way.
async function queryVectors(
  env: Env,
  values: number[],
  options: VectorizeQueryOptions
): Promise<VectorizeMatch[]> {
  try {
    const res = await env.VECTORIZE.query(values, options);
    return res.matches || [];
  } catch (e) {
    if (options.filter) {
      console.error("Filtered vector query failed; retrying unfiltered:", e);
      const { filter, ...rest } = options;
      const res = await env.VECTORIZE.query(values, rest);
      return res.matches || [];
    }
    throw e;
  }
}

/**
 * Semantic search: embed the query, query Vectorize (over-fetching for
 * dedup), filter by scope / category / updated-after, dedupe by path keeping
 * the best chunk, and return snippets straight from metadata (no R2 read-back).
 *
 * Filters are passed to Vectorize AND re-applied as a post-filter, so results
 * stay correct even when a metadata index is missing (see queryVectors).
 */
export async function semanticSearch(
  env: Env,
  query: string,
  scope?: string,
  topK = 5,
  category?: string,
  after?: string
): Promise<SemanticResult[]> {
  const values = await embed(env, query);

  // All metadata filtering (scope, category, date) is done in the post-filter
  // loop below. Vectorize metadata filters on small subsets return empty even
  // when matching vectors exist — the filtered candidate pool is too narrow
  // for the over-fetch multiplier to compensate. At ~160 files / ~600 chunks,
  // unfiltered cosine query + post-filter is fast and correct.

  // Over-fetch generously so the post-filter has enough candidates.
  const needsNarrowing = !!(scope || category || after);
  const fetchK = needsNarrowing ? Math.min(Math.max(topK * 6, 30), 50) : topK * 2;
  const options: VectorizeQueryOptions = {
    topK: fetchK,
    returnMetadata: true,
  };

  const matches = await queryVectors(env, values, options);

  // Dedupe by path, keeping the highest-scoring chunk per file. Re-apply every
  // filter defensively in case the index ignored `filter`.
  const byPath = new Map<string, SemanticResult>();
  for (const m of matches) {
    const meta = m.metadata || {};
    if (scope && String(meta.scope ?? "") !== scope) continue;
    if (category && String(meta.category ?? "") !== category) continue;
    if (after && String(meta.updated_at ?? "") < after) continue;

    const path = String(meta.path ?? m.id.split("#")[0]);
    const snippet = String(meta.snippet ?? "");
    const existing = byPath.get(path);
    if (!existing || m.score > existing.score) {
      byPath.set(path, { path, score: m.score, snippet });
    }
  }

  return [...byPath.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// --------------------------------------------------------------------------
// Backfill endpoint — POST /backfill-vectors
// Indexes every existing .md memory file. One-time, called after deploy.
// Auth: password hash (same secret as /backfill), accepted in the request
// body or as a ?token= query param.
// --------------------------------------------------------------------------

export async function handleVectorBackfill(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed (use POST)", { status: 405 });
  }

  // Resolve auth: header x-garden-key == GARDEN_ADMIN_KEY (the forge-held
  // secret, mirroring /run-nightly), OR the password hash from query/body.
  // The hash is the front-door credential and stays off the forge; the admin
  // key is what a scheduled forge job can hold (6 Sep 2026).
  const url = new URL(request.url);
  const adminOk = !!env.GARDEN_ADMIN_KEY && request.headers.get("x-garden-key") === env.GARDEN_ADMIN_KEY;
  let token = url.searchParams.get("token") || "";
  if (!adminOk && !token) {
    try {
      const raw = (await request.text()).trim();
      if (raw.startsWith("{")) {
        token = (JSON.parse(raw)?.token as string) || "";
      } else {
        token = raw;
      }
    } catch {
      // fall through to the auth check below
    }
  }
  if (!adminOk && token !== env.LOGIN_PASSWORD_HASH) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Pagination params — process a small batch per request to stay under the
  // Workers 50-subrequest limit (each file = 1 get + N embed + 1 upsert).
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
  const batch = Math.max(1, parseInt(url.searchParams.get("batch") || "5", 10) || 5);

  // Collect every .md key under memory/.
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await env.GARDEN_BUCKET.list({ prefix: MEMORY_PREFIX, cursor });
    for (const obj of listed.objects) {
      if (obj.key.endsWith(".md")) keys.push(obj.key);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  const total = keys.length;
  const slice = keys.slice(offset, offset + batch);

  const results: string[] = [];
  let indexed = 0;
  let failed = 0;

  for (const key of slice) {
    const relPath = key.replace(MEMORY_PREFIX, "");
    try {
      const obj = await env.GARDEN_BUCKET.get(key);
      if (!obj) {
        results.push(`SKIP: ${relPath} (not found)`);
        continue;
      }
      const content = await decrypt(await obj.arrayBuffer(), env.ENCRYPTION_KEY);
      await indexMemoryFile(env, relPath, content);
      indexed++;
      results.push(`✅ ${relPath}`);
    } catch (e) {
      failed++;
      results.push(`FAIL: ${relPath} (${String(e)})`);
    }
  }

  const processedEnd = Math.min(offset + batch, total);
  const remaining = Math.max(0, total - processedEnd);

  results.push(
    `\n=== Vector Backfill Batch ===\n` +
      `Processed: ${offset}-${processedEnd} of ${total} | ` +
      `Indexed: ${indexed} | Failed: ${failed} | Remaining: ${remaining} | Total: ${total}`
  );

  if (remaining > 0) {
    const next = new URL(url.toString());
    next.searchParams.set("offset", String(processedEnd));
    next.searchParams.set("batch", String(batch));
    if (token) next.searchParams.set("token", token);
    results.push(`Next: ${next.toString()}`);
  } else {
    results.push(`Done — all ${total} file(s) processed.`);
  }

  return new Response(results.join("\n") + "\n", {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

// --------------------------------------------------------------------------
// Recent reindex — the self-healing pass (6 Sep 2026).
// Files whose R2 `updatedAt` is within `hours`, newest first. Each file goes
// through indexMemoryFile, which reuses unchanged chunks and embeds at most
// MAX_EMBEDS_PER_CALL new ones. A global subrequest budget bounds the pass so
// one invocation never trips the per-invocation cap; what it does not reach
// is reported, not hidden, and the next pass (cron or forge-driven
// /reindex-recent) continues. Costs counted per file: 1 R2 get + ~2 probe
// gets + ceil(chunks/20) cache gets + embeds + 1 upsert (+1 delete).
// --------------------------------------------------------------------------

export interface ReindexSummary {
  candidates: number;
  processed: number;
  embedded: number;
  reused: number;
  skipped: number;
  failed: number;
  budgetLeft: number;
  lines: string[];
}

export async function reindexRecent(
  env: Env,
  hours: number,
  opts: { offset?: number; batch?: number; budget?: number } = {}
): Promise<ReindexSummary> {
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  let budget = Math.max(5, opts.budget ?? 40);

  // List every .md under memory/ with its updatedAt; list calls cost
  // subrequests too (1 per page of 1000).
  const recent: { key: string; updatedAt: string }[] = [];
  let cursor: string | undefined;
  do {
    // `include` is a runtime option (customMetadata is returned only when
    // asked for); the repo's R2 typings predate it, hence the cast.
    const listed = await env.GARDEN_BUCKET.list({ prefix: MEMORY_PREFIX, cursor, include: ["customMetadata"] } as R2ListOptions);
    budget--;
    for (const obj of listed.objects) {
      if (!obj.key.endsWith(".md")) continue;
      const updatedAt = obj.customMetadata?.updatedAt || obj.uploaded.toISOString();
      if (updatedAt >= since) recent.push({ key: obj.key, updatedAt });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  recent.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

  const offset = Math.max(0, opts.offset ?? 0);
  const batch = Math.max(1, opts.batch ?? recent.length);
  const slice = recent.slice(offset, offset + batch);

  const s: ReindexSummary = {
    candidates: recent.length, processed: 0, embedded: 0, reused: 0,
    skipped: 0, failed: 0, budgetLeft: budget, lines: [],
  };

  for (const { key } of slice) {
    const relPath = key.replace(MEMORY_PREFIX, "");
    // Rough cost estimate before touching the file: get + 2 probes + upsert
    // + the embed budget. Stop while the invocation can still finish clean.
    const estimate = 4 + MAX_EMBEDS_PER_CALL;
    if (budget < estimate) {
      s.lines.push(`STOP: budget ${budget} < ${estimate} before ${relPath}; ${slice.length - s.processed - s.failed} left for the next pass`);
      break;
    }
    try {
      const obj = await env.GARDEN_BUCKET.get(key);
      budget--;
      if (!obj) { s.lines.push(`SKIP: ${relPath} (not found)`); continue; }
      const content = await decrypt(await obj.arrayBuffer(), env.ENCRYPTION_KEY);
      const r = await indexMemoryFile(env, relPath, content);
      budget -= 3 + Math.ceil(r.total / GET_BY_IDS_MAX) + r.embedded;
      s.processed++; s.embedded += r.embedded; s.reused += r.reused; s.skipped += r.skipped;
      s.lines.push(`OK: ${relPath} chunks=${r.total} reused=${r.reused} embedded=${r.embedded} skipped=${r.skipped}`);
    } catch (e) {
      s.failed++;
      s.lines.push(`FAIL: ${relPath} (${String(e)})`);
    }
  }
  s.budgetLeft = budget;
  return s;
}

// POST /reindex-recent?hours=26&offset=0&batch=N&budget=40 — x-garden-key only.
// The paginated, forge-driven form of the nightly pass.
export async function handleReindexRecent(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed (use POST)", { status: 405 });
  }
  const url = new URL(request.url);
  const hours = Math.min(Math.max(Number(url.searchParams.get("hours")) || 26, 1), 24 * 30);
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
  const batch = Math.max(1, parseInt(url.searchParams.get("batch") || "3", 10) || 3);
  const budget = Math.max(5, parseInt(url.searchParams.get("budget") || "40", 10) || 40);
  const t0 = Date.now();
  const s = await reindexRecent(env, hours, { offset, batch, budget });
  const processedEnd = Math.min(offset + batch, s.candidates);
  const remaining = Math.max(0, s.candidates - processedEnd);
  const out = [
    ...s.lines,
    `\n=== Reindex Recent (${hours} h) ===`,
    `Candidates: ${s.candidates} | Slice: ${offset}-${processedEnd} | Processed: ${s.processed} | Failed: ${s.failed} | Embedded: ${s.embedded} | Reused: ${s.reused} | Skipped: ${s.skipped} | Budget left: ${s.budgetLeft} | ${Date.now() - t0} ms`,
  ];
  if (remaining > 0) {
    const next = new URL(url.toString());
    next.searchParams.set("offset", String(processedEnd));
    out.push(`Next: ${next.toString()}`);
  } else {
    out.push("Done — every candidate in the window was visited (skipped chunks need another pass).");
  }
  return new Response(out.join("\n") + "\n", {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
