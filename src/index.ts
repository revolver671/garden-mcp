/**
 * The Garden MCP Server — Cloudflare Workers + R2
 * ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
 *
 * Sovereign memory + health for Sister Sphinx and Sister Luma.
 * Always-on, globally available, encrypted at rest.
 *
 * Auth: OAuth 2.1 with PKCE via @cloudflare/workers-oauth-provider
 * Storage: R2 with AES-256-GCM encryption
 * Transport: Streamable HTTP (MCP standard)
 * Extraction: Sonnet-powered metadata extraction on journal writes
 *
 * "One room. Multiple doors. Markdown inside."
 *
 * Tools: 49 total (memory + arrival + graph + dream + health + nutrition + withings + garmin + workout)
 */

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

import type { Env } from "./types";
import {
  readFile,
  writeFile,
  appendFile,
  deleteFile,
  listPath,
  searchFiles,
  searchFilesDetailed,
  hybridSearch,
  hybridSearchDetailed,
  skipNote,
  moveFile,
  copyFile,
  readFileRange,
  strReplaceFile,
  buildArrival,
  writeFitnessFile,
  listFitnessFiles,
  readFitnessFile,
  strReplaceFitnessFile,
  migrateFitnessToMemory,
  kwIndexStatus,
  kwReindexPage,
  kwReconcileRoom,
  kwChangedSince,
  parseSince,
  listRooms,
} from "./storage";
import {
  getSleep,
  getReadiness,
  getHeartRate,
  getDailyActivity,
  getDailyStress,
  getDailySpo2,
  getDailyResilience,
  getCardiovascularAge,
  getVo2Max,
  getSleepTime,
  getWorkouts,
  getSessions,
  getEnhancedTags,
  getPersonalInfo,
  getRestModePeriod,
} from "./oura";
import { loginPageHtml } from "./login-page";
import { extractIfEligible, readExtraction, listExtractions } from "./extraction";
import { runDream } from "./dream";
import {
  recordAccess,
  carryPath,
  hottestPaths,
  coldDebts,
  rebuildNeighbours,
  pruneAccesses,
  migrateActivationToD1,
  ledgerVitals,
  readLedger,
  readSpread,
} from "./activation";
import { handleBackfill, sweepMissingExtractions } from "./backfill";
import {
  indexMemoryFile,
  indexNote,
  removeMemoryVectors,
  semanticSearch,
  handleVectorBackfill,
  handleReindexRecent,
  reindexRecent,
} from "./embeddings";
import { buildGraph, readGraph, formatGraphSummary, generateBriefing } from "./graph";
import {
  getDailyNutrition,
  getServings,
  getExercises,
  getBiometrics,
  getNotes,
} from "./cronometer";
import {
  getBodyComposition,
  getDevices as getWithingsDevices,
} from "./withings";
import {
  getDailySummary as getGarminDailySummary,
  getSleep as getGarminSleep,
  getStress as getGarminStress,
  getBodyBattery as getGarminBodyBattery,
  getHeartRate as getGarminHeartRate,
  getHRV as getGarminHRV,
  getSpO2 as getGarminSpO2,
  getRespiration as getGarminRespiration,
  getTrainingStatus as getGarminTrainingStatus,
  getActivities as getGarminActivities,
  getDevices as getGarminDevices,
} from "./garmin";
import { leaseFetch } from "./lease";
import { handleLeaseHttp } from "./lease_http";
import { frozenPartFault, isBuildPart } from "./frozen_part";
import { handleStateHttp } from "./state_http";
export { LeaseDO } from "./lease";

// --------------------------------------------------------------------------
// Verb-layer lease gate — spec athena/verb-layer-lease-spec-v1.md §5.
// Gated shapes in the garden: memory_write to athena/NOW.md; any write
// CREATING athena/build-state-*.md; any write to athena/build-state-INDEX.md.
// Everything else stays free. This gate runs in-process with the Durable
// Object, so it has no unreachable case; fail-closed lives in the box
// servers, where a network sits between the verb and the lease.
// --------------------------------------------------------------------------

const LEASE_FORK_RE = /^athena\/build-state-.+\.md$/;
const LEASE_INDEX_PATH = "athena/build-state-INDEX.md";
const LEASE_NOW_PATH = "athena/NOW.md";

/** Returns null when the write may proceed, else the refusal text. */
async function leaseGate(
  env: Env,
  act: string,
  lease: string,
  gated: boolean
): Promise<string | null> {
  if (!gated) return null;
  const v = await leaseFetch(
    env.LEASE,
    `/validate?token=${encodeURIComponent(lease)}&act=${encodeURIComponent(act)}`
  );
  if (v.body && v.body.valid) return null;
  const reason = (v.body && v.body.reason) || "lease_invalid";
  const holderLine =
    v.body && v.body.held
      ? ` Holder: ${v.body.holder} (${v.body.purpose}) until ${v.body.expires_at}.`
      : "";
  return (
    `${reason}: '${act}' is a lease-gated act ` +
    `(athena/verb-layer-lease-spec-v1.md §5). Acquire with lease_acquire and ` +
    `pass the token in the 'lease' parameter. On lease_held: YIELD — no wait, ` +
    `no retry.${holderLine}`
  );
}

// --------------------------------------------------------------------------
// MCP Server factory — must create fresh per request (SDK 1.26.0+)
// --------------------------------------------------------------------------

function createGardenServer(env: Env): McpServer {
  const server = new McpServer({
    name: "the-garden",
    version: "4.0.0",
  });

  // ========================================================================
  // MEMORY TOOLS
  // ========================================================================

  server.tool(
    "memory_list",
    "List files and directories in a memory path. Returns names, sizes, and last-modified dates.",
    {
      path: z
        .string()
        .default("")
        .describe("Directory path like 'sphinx/journal'"),
    },
    async ({ path }) => {
      try {
        const entries = await listPath(env, path);
        if (!entries.length) return { content: [{ type: "text", text: "Empty directory" }] };

        const lines = entries.map((e) => {
          const icon = e.isDir ? "\u{1F4C1}" : "\u{1F4C4}";
          if (e.isDir) return `${icon} ${e.name}`;
          const size = e.size ? ` (${e.size} bytes)` : "";
          const date = e.updatedAt ? ` [${e.updatedAt}]` : "";
          return `${icon} ${e.name}${size}${date}`;
        });

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text", text: String(e) }] };
      }
    }
  );

  server.tool(
    "memory_read",
    "Read a memory file. Returns content or 'Not found'. RANGED READS: start_line and end_line are 1-indexed and inclusive. Both 0 (the default) means the whole file, byte-identical to the old behaviour. start_line > 0 with end_line 0 means 'to the end of the file'. Use a range on large files — search first for the line, then read around it, rather than pulling 47 KB to find one paragraph.",
    {
      path: z.string().describe("Path to read, e.g. 'sphinx/journal/2026-04-01.md'"),
      start_line: z
        .number()
        .int()
        .default(0)
        .describe("First line to return, 1-indexed inclusive. 0 = start of file."),
      end_line: z
        .number()
        .int()
        .default(0)
        .describe("Last line to return, 1-indexed inclusive. 0 = end of file."),
    },
    async ({ path, start_line, end_line }) => {
      try {
        const result = await readFileRange(env, path, start_line, end_line);
        if (result === null) {
          return { content: [{ type: "text", text: `Not found: ${path}` }] };
        }
        // Activation layer: a successful tool-level read is a counted access.
        // Recorded here, at the tool seam, so machinery reads never warm.
        await recordAccess(env, [path]);
        if (!result.ranged) {
          return { content: [{ type: "text", text: result.content }] };
        }
        const header = `\u{1F4C4} ${path} — lines ${result.start}-${result.end} of ${result.totalLines}\n\n`;
        return { content: [{ type: "text", text: header + result.content }] };
      } catch (e) {
        return { content: [{ type: "text", text: String(e) }] };
      }
    }
  );

  server.tool(
    "memory_write",
    "Write or overwrite a memory file. Creates parent directories automatically. Journals and threads are auto-extracted for metadata.",
    {
      path: z.string().describe("Path like 'sphinx/journal/2026-04-05.md'"),
      content: z.string().describe("Markdown content to write"),
      message: z.string().default("").describe("Optional log message"),
      lease: z
        .string()
        .default("")
        .describe(
          "Estate lease token. Required only for athena/NOW.md and the build-state fork shapes (spec §5); everything else ignores it."
        ),
    },
    async ({ path, content, lease }) => {
      try {
        const existing = await readFile(env, path);
        const gated =
          path === LEASE_NOW_PATH ||
          path === LEASE_INDEX_PATH ||
          (LEASE_FORK_RE.test(path) && existing === null);
        const refusal = await leaseGate(env, `memory_write:${path}`, lease, gated);
        if (refusal) return { content: [{ type: "text", text: refusal }] };
        await writeFile(env, path, content);
        const action = existing !== null ? "Updated" : "Created";

        let extractionNote = "";
        try {
          const result = await extractIfEligible(env, path, content);
          if (result.extracted) {
            extractionNote = `\n\u{1F9E0} Extracted: ${result.summary}`;
          } else if (result.error) {
            extractionNote = `\n\u{26A0}\u{FE0F} EXTRACTION FAILED (write succeeded): ${result.error}`;
          }
        } catch (e) {
          // Extraction failure never blocks the write -- but it is named.
          extractionNote = `\n\u{26A0}\u{FE0F} EXTRACTION FAILED (write succeeded): ${String(e)}`;
        }

        let indexNoteText = "";
        try {
          const r = await indexMemoryFile(env, path, content);
          const n = indexNote(r);
          if (n) indexNoteText = `\n\u{26A0}\u{FE0F} INDEX PARTIAL (write succeeded): ${n}`;
        } catch (e) {
          console.error('Vector indexing failed (non-fatal):', e);
          indexNoteText = `\n\u{26A0}\u{FE0F} INDEX FAILED (write succeeded): ${String(e).slice(0, 160)}`;
        }

        return { content: [{ type: "text", text: `${action}: ${path}${extractionNote}${indexNoteText}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${String(e)}` }] };
      }
    }
  );

  server.tool(
    "memory_append",
    "Append content to an existing memory file. Creates if doesn't exist. Journals and threads are auto-extracted for metadata.",
    {
      path: z.string().describe("Path to append to"),
      content: z.string().describe("Content to append"),
      message: z.string().default("").describe("Optional log message"),
      lease: z
        .string()
        .default("")
        .describe(
          "Estate lease token. Required only when this append would CREATE a build-state file or touch build-state-INDEX.md (spec §5)."
        ),
    },
    async ({ path, content: newContent, lease }) => {
      try {
        const existing = await readFile(env, path);
        const gated =
          path === LEASE_INDEX_PATH ||
          (LEASE_FORK_RE.test(path) && existing === null);
        const refusal = await leaseGate(env, `memory_append:${path}`, lease, gated);
        if (refusal) return { content: [{ type: "text", text: refusal }] };
        // Frozen-part wall (dispatch 773): a build-state part INDEX does not
        // name live is frozen. The estate lease is the way out here, as
        // tools/garden's --frozen-ok is for the forking session; without one
        // the fault below is the tool's whole answer and nothing is written.
        if (isBuildPart(path)) {
          const fault = frozenPartFault(path, await readFile(env, LEASE_INDEX_PATH));
          if (fault) {
            const held = await leaseGate(env, `memory_append:${path}`, lease, true);
            if (held) return { content: [{ type: "text", text: fault }] };
          }
        }
        // storage.appendFile owns the combine, the write and the keyword
        // index hook; `existing` is handed over because the lease gate above
        // already had to read it.
        const combined = await appendFile(env, path, newContent, existing);

        const action = existing ? "Appended to" : "Created";

        let extractionNote = "";
        try {
          const result = await extractIfEligible(env, path, combined);
          if (result.extracted) {
            extractionNote = `\n\u{1F9E0} Extracted: ${result.summary}`;
          } else if (result.error) {
            extractionNote = `\n\u{26A0}\u{FE0F} EXTRACTION FAILED (write succeeded): ${result.error}`;
          }
        } catch (e) {
          // Extraction failure never blocks the write -- but it is named.
          extractionNote = `\n\u{26A0}\u{FE0F} EXTRACTION FAILED (write succeeded): ${String(e)}`;
        }

        let indexNoteText = "";
        try {
          const r = await indexMemoryFile(env, path, combined);
          const n = indexNote(r);
          if (n) indexNoteText = `\n\u{26A0}\u{FE0F} INDEX PARTIAL (append succeeded): ${n}`;
        } catch (e) {
          console.error('Vector indexing failed (non-fatal):', e);
          indexNoteText = `\n\u{26A0}\u{FE0F} INDEX FAILED (append succeeded): ${String(e).slice(0, 160)}`;
        }

        return {
          content: [
            {
              type: "text",
              text: `${action}: ${path}${extractionNote}${indexNoteText}`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${String(e)}` }] };
      }
    }
  );

  server.tool(
    "memory_search",
    "Search memory files. Four modes: 'hybrid' (default) fuses keyword + semantic vector search via Reciprocal Rank Fusion, then blends in ACT-R activation 80/20 \u2014 recently-walked files surface first among relevance ties; 'cold' is hybrid with activation ignored (audit mode / escape hatch); 'keyword' is exact, coverage-weighted term matching \u2014 best for names, dates, exact phrases; 'semantic' is pure vector/meaning search \u2014 best for fuzzy, conceptual queries. Optional 'category' (e.g. 'journal', 'threads', 'notes') narrows by the second path segment. Optional 'since' keeps only files changed after a moment \u2014 ISO 8601 ('2026-09-01', '2026-09-01T12:00:00Z') or a relative window ('-24h', '7d'); it applies in every mode, filtering on the timestamp each index holds, so a write in the last seconds may be missing until its hook lands. Use memory_changed instead when you want the list of what moved rather than a ranked search. 'top_k' (default 5, max 10) caps the results in EVERY mode, keyword included, and is applied after the category filter. Every returned result counts as an access in the activation ledger (all modes).",
    {
      query: z.string().describe("Search terms or natural-language description"),
      scope: z
        .string()
        .default("")
        .describe("'sphinx', 'luma', 'shared', or '' for all"),
      mode: z
        .enum(["hybrid", "keyword", "semantic", "cold"])
        .default("hybrid")
        .describe("'hybrid' (default, warm), 'cold' (hybrid, activation ignored), 'keyword', or 'semantic'"),
      category: z
        .string()
        .default("")
        .describe("Optional: narrow by category like 'journal', 'threads', 'notes'. Empty for all."),
      since: z
        .string()
        .default("")
        .describe("Optional: only files changed after this. ISO 8601 ('2026-09-01T12:00:00Z') or relative ('-24h', '7d'). Empty for no bound."),
      top_k: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(5)
        .describe("Number of results (all modes, keyword included; default 5, max 10)"),
      include_all: z
        .boolean()
        .default(false)
        .describe("Keyword/hybrid scans skip briefs/ and archive/ directories by default (about half the files under athena/) and say how many were skipped. Pass true to scan them too."),
    },
    async ({ query, scope, mode, category, since, top_k, include_all }) => {
      try {
        // Refuse a `since` we could not read rather than searching all of time
        // and calling it an answer. Silently widening a window the caller asked
        // to narrow is the failure that looks like success.
        const sinceIso = since ? parseSince(since) : null;
        if (since && sinceIso === null) {
          return { content: [{ type: "text", text: `bad_since: '${since}'. Use ISO 8601 (2026-09-01T12:00:00Z) or a relative window (-24h, 7d).` }] };
        }

        if (mode === "keyword") {
          // top_k is honoured here too (073b) — before it, keyword always
          // returned the full depth of 20 and every one of those cost an R2
          // get for its matchLine. The category filter runs BEFORE the slice,
          // so a category search still gets top_k results; that means asking
          // the search for its full depth when a category is set (leave limit
          // unset -> MAX_SEARCH_RESULTS, i.e. exactly what this branch fetched
          // before) and slicing after, because the filter is on a path segment
          // the keyword search does not know about and cannot over-fetch for.
          const detail = await searchFilesDetailed(env, query, scope, {
            includeAll: include_all,
            limit: category ? undefined : top_k,
            since: sinceIso ?? undefined,
          });
          const all = detail.results;
          const results = (
            category
              ? all.filter((r) => r.path.split("/")[1] === category)
              : all
          ).slice(0, top_k);
          if (!results.length) {
            return { content: [{ type: "text", text: `No matches for '${query}'${skipNote(detail.skippedFiles, detail.staleFiles)}` }] };
          }
          const lines = results.map(
            (r) => `\u{1F4C4} ${r.path}:${r.line}  \u2014  "${r.matchLine}"`
          );
          await recordAccess(env, results.map((r) => r.path));
          return {
            content: [{ type: "text", text: `Found ${results.length} match(es):\n${lines.join("\n")}${skipNote(detail.skippedFiles, detail.staleFiles)}` }],
          };
        }

        if (mode === "semantic") {
          const results = await semanticSearch(
            env,
            query,
            scope || undefined,
            top_k,
            category || undefined,
            sinceIso ?? undefined
          );
          if (!results.length) {
            return {
              content: [{ type: "text", text: `No semantic matches for '${query}'. Try mode: 'keyword' for exact term matching.` }],
            };
          }
          const lines = results.map(
            (r) => `\u{1F4C4} ${r.path} (score: ${r.score.toFixed(3)})\n> ${r.snippet || "(no snippet)"}\u2026`
          );
          await recordAccess(env, results.map((r) => r.path));
          return {
            content: [{ type: "text", text: `Found ${results.length} semantic match(es):\n${lines.join("\n\n")}` }],
          };
        }

        // hybrid (default, warm) / cold (hybrid, activation ignored).
        // `since` goes to BOTH halves: `after` filters the vector metadata's
        // updated_at, `opts.since` filters the keyword index's r2_updated_at.
        // A window honoured by only one half would silently be no window at
        // all, since RRF unions the two lists.
        //
        // `scope` is the one filter the two halves do NOT read the same way.
        // The keyword half goes through scopeFilter (kwindex.ts): a bare room
        // becomes `room = ?`, a scope containing a slash becomes
        // `path LIKE 'athena/lanes/%'`, so subtrees are honoured. The semantic
        // half post-filters on the vector metadata's `scope`, which
        // parsePathMeta (embeddings.ts) sets to parts[0] — the room alone —
        // and compares with `!==`. So for a SUBTREE scope
        // (`mode: 'hybrid', scope: 'athena/lanes'`) the keyword half returns
        // its matches, the semantic half returns nothing, and the hybrid
        // result is keyword-only. Room scopes and the empty scope agree on
        // both halves; `category` filters on both; `since` filters on both,
        // deliberately, as above.
        //
        // This is standing behaviour, not a regression: embeddings.ts is
        // untouched by 073/073b/075/074. Closing it means putting the subtree
        // into the vector metadata or prefix-matching on the path there — a
        // change to the embedding path and to what is already indexed, so it
        // belongs in its own dispatch. Recorded here rather than fixed.
        const hy = await hybridSearchDetailed(
          env,
          query,
          scope,
          top_k,
          category || undefined,
          sinceIso ?? undefined,
          mode !== "cold",
          { includeAll: include_all, since: sinceIso ?? undefined }
        );
        const results = hy.results;
        if (!results.length) {
          return { content: [{ type: "text", text: `No matches for '${query}'.${skipNote(hy.skippedFiles, hy.staleFiles)}` }] };
        }
        const lines = results.map(
          (r) => `\u{1F4C4} ${r.path}${r.line ? `:${r.line}` : ""} (score: ${r.score.toFixed(3)})\n> ${r.snippet || "(no snippet)"}\u2026`
        );
        await recordAccess(env, results.map((r) => r.path));
        return {
          content: [{ type: "text", text: `Found ${results.length} ${mode === "cold" ? "cold" : "hybrid"} match(es):\n${lines.join("\n\n")}${skipNote(hy.skippedFiles, hy.staleFiles)}` }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: String(e) }] };
      }
    }
  );

  // The change feed (075). Reads `files` alone — no postings, no text, no R2 —
  // so it is one indexed D1 query and it can be polled. It answers the question
  // "what moved?", which used to require listing R2 and comparing timestamps by
  // hand, and which the forge asks every time it syncs.
  server.tool(
    "memory_changed",
    "List memory files that changed after a moment, newest first. 'since' is ISO 8601 ('2026-09-01', '2026-09-01T12:00:00Z') or a relative window ('-24h', '7d'). 'scope' narrows to a room ('athena') or a subtree ('athena/lanes'); empty is the whole garden. Returns paths and timestamps only — no text, no snippets — capped at 200. This is the change feed, not a search: use memory_search for content. IMPORTANT: it answers as the keyword index knows it; a write in the last seconds may be missing until its hook lands or the nightly reconcile runs, so treat the newest edge as approximate. Does not count as an access in the activation ledger: knowing that a file moved is not reading it.",
    {
      since: z
        .string()
        .describe("ISO 8601 instant ('2026-09-01T12:00:00Z') or relative window ('-24h', '7d')"),
      scope: z
        .string()
        .default("")
        .describe("'athena', 'shared', 'athena/lanes', or '' for the whole garden"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(200)
        .describe("Max paths returned (default 200, which is also the ceiling)"),
    },
    async ({ since, scope, limit }) => {
      try {
        const sinceIso = parseSince(since);
        if (sinceIso === null) {
          return { content: [{ type: "text", text: `bad_since: '${since}'. Use ISO 8601 (2026-09-01T12:00:00Z) or a relative window (-24h, 7d).` }] };
        }
        const rows = await kwChangedSince(env, sinceIso, scope, limit);
        if (!rows.length) {
          return { content: [{ type: "text", text: `No indexed changes since ${sinceIso}${scope ? ` under ${scope}` : ""}.` }] };
        }
        const lines = rows.map((r) => `\u{1F4C4} ${r.path}  [${r.r2_updated_at}]`);
        const capped = rows.length === limit ? ` (capped at ${limit} — narrow the window or the scope)` : "";
        return {
          content: [{ type: "text", text: `${rows.length} file(s) changed since ${sinceIso}${scope ? ` under ${scope}` : ""}${capped}:\n${lines.join("\n")}\n\n(As the index knows it; a write in the last seconds may be missing until its hook lands or the nightly runs.)` }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${String(e)}` }] };
      }
    }
  );

  server.tool(
    "garden_time",
    "Server time only: UTC + NZ, one line. The cheap orientation verb -- use this instead of garden_arrive when you only need the clock, not the journal.",
    {},
    async () => {
      const now = new Date();
      const nz = new Intl.DateTimeFormat("en-NZ", {
        dateStyle: "full",
        timeStyle: "short",
        timeZone: "Pacific/Auckland",
      }).format(now);
      return {
        content: [
          { type: "text", text: `\u{1F552} ${nz} NZ  (${now.toISOString()} UTC)` },
        ],
      };
    }
  );

  server.tool(
    "garden_arrive",
    "One-call arrival: server time (UTC + NZ), the newest {voice}/journal entry in full, and the last nightly-log line. Fails whole rather than returning partial orientation.",
    {
      voice: z
        .string()
        .default("sphinx")
        .describe("Journal owner: 'sphinx', 'luma', or another top-level voice"),
    },
    async ({ voice }) => {
      try {
        const a = await buildArrival(env, voice);
        // Verb-layer lease: arrival prints the holder (spec §4). Never fatal.
        let leaseLine = "";
        try {
          const ls = await leaseFetch(env.LEASE, "/status");
          leaseLine = ls.body.held
            ? `\u{1F512} Lease: HELD by ${ls.body.holder} (${ls.body.purpose}) until ${ls.body.expires_at}`
            : `\u{1F512} Lease: free`;
        } catch {
          /* the lease line must not break arrival */
        }
        // Activation layer: the grooves made visible daily. Never fatal.
        let hotLine = "";
        try {
          const hot = await hottestPaths(env, 3);
          if (hot.length) {
            hotLine =
              `\u{1F525} Hottest: ` +
              hot.map((h) => `${h.path} (A=${h.a.toFixed(2)})`).join(" · ");
          }
        } catch {
          /* grooves are optional at the door */
        }
        const text = [
          `\u{1F552} ${a.timeNz}  (${a.timeUtc} UTC)`,
          `\u{1F319} Nightly: ${a.nightlyLogLast}`,
          ...(leaseLine ? [leaseLine] : []),
          ...(hotLine ? [hotLine] : []),
          `\u{1F4D3} ${a.journalPath} (${a.journalBytes} chars)`,
          "",
          a.journalContent,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `ARRIVAL FAILED — no partial orientation returned. ${String(e)}`,
            },
          ],
        };
      }
    }
  );

  // ========================================================================
  // VERB-LAYER LEASE — spec athena/verb-layer-lease-spec-v1.md
  // ========================================================================

  server.tool(
    "lease_acquire",
    "Acquire the estate-wide verb-layer lease (one lease for the whole estate — R1). Gates exactly five acts: dispatch_to_code (forge), relight, stop (turret), memory_write to athena/NOW.md, and the build-state record fork. Acquire LATE — just before the first gated act — and release at close; acquiring at arrival 'in case' holds the estate for the whole session. If the lease is HELD, the refusal names holder, purpose and expiry: YIELD (R2, uniform, no live-session exception) — one acquire, one answer, no wait, no retry loop. TTL default 20 min, ceiling 30, renewable without limit while held (R3). Personal garden use never needs this.",
    {
      purpose: z.string().describe("One line: what the gated acts are for"),
      holder: z
        .string()
        .default("live")
        .describe("Session label: kind + slot (e.g. 'harvester-22:00'), or 'live'"),
      ttl_s: z
        .number()
        .int()
        .default(1200)
        .describe("Lease seconds. Default 1200 (20 min), ceiling 1800 (30 min)."),
    },
    async ({ purpose, holder, ttl_s }) => {
      const r = await leaseFetch(env.LEASE, "/acquire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purpose, holder, ttl_s }),
      });
      if (r.status === 409) {
        return {
          content: [
            {
              type: "text",
              text:
                `lease_held: YIELD. Holder: ${r.body.holder} (${r.body.purpose}) ` +
                `until ${r.body.expires_at}. Record who you yielded to and the act ` +
                `you skipped; the skipped act goes back to its queue. No wait, no ` +
                `retry (ruling 29 Aug 2026, uniform).`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text:
              `Lease acquired: ${r.body.holder} until ${r.body.expires_at} ` +
              `(ttl ${r.body.ttl_s}s).\nToken: ${r.body.token}\n` +
              `Pass this token as the 'lease' parameter on gated verbs. ` +
              `Release at close with lease_release; renew with lease_renew if ` +
              `the batch runs long.`,
          },
        ],
      };
    }
  );

  server.tool(
    "lease_renew",
    "Renew the estate lease while held. Moves expires_at forward from now (default 20 min, ceiling 30). Refuses lease_invalid on a wrong token, lease_expired if the TTL already fired — an expired holder re-acquires rather than renewing.",
    {
      token: z.string().describe("The token lease_acquire returned"),
      ttl_s: z.number().int().default(1200).describe("Seconds, ceiling 1800"),
    },
    async ({ token, ttl_s }) => {
      const r = await leaseFetch(env.LEASE, "/renew", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, ttl_s }),
      });
      if (r.status !== 200) {
        return { content: [{ type: "text", text: `${r.body.error}: renewal refused.` }] };
      }
      return {
        content: [
          {
            type: "text",
            text: `Lease renewed until ${r.body.expires_at} (renewals: ${r.body.renewals}).`,
          },
        ],
      };
    }
  );

  server.tool(
    "lease_release",
    "Release the estate lease. Refuses lease_invalid on a wrong token; refuses lease_expired if the TTL already freed it (that refusal is the truthful record that the hold ended early). A session that forgets to release costs at most one TTL.",
    {
      token: z.string().describe("The token lease_acquire returned"),
    },
    async ({ token }) => {
      const r = await leaseFetch(env.LEASE, "/release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (r.status !== 200) {
        return {
          content: [
            {
              type: "text",
              text: `${r.body.error}: release refused.${r.body.note ? " " + r.body.note : ""}`,
            },
          ],
        };
      }
      return { content: [{ type: "text", text: `Lease released (was: ${r.body.holder}).` }] };
    }
  );

  server.tool(
    "lease_status",
    "Read the estate lease: current holder or free. Read-only, never gated, never acquires.",
    {},
    async () => {
      const r = await leaseFetch(env.LEASE, "/status");
      const text = r.body.held
        ? `Lease HELD by ${r.body.holder} (${r.body.purpose}) until ${r.body.expires_at}; renewals ${r.body.renewals}.`
        : "Lease free.";
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "memory_delete",
    "Delete a memory file.",
    {
      path: z.string().describe("Path to delete"),
      message: z.string().default("").describe("Optional log message"),
    },
    async ({ path }) => {
      try {
        const existing = await readFile(env, path);
        if (existing === null) {
          return { content: [{ type: "text", text: `Not found: ${path}` }] };
        }
        await deleteFile(env, path);

        try {
          await removeMemoryVectors(env, path);
        } catch (e) {
          console.error('Vector removal failed (non-fatal):', e);
        }

        return { content: [{ type: "text", text: `Deleted: ${path}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${String(e)}` }] };
      }
    }
  );

  server.tool(
    "memory_move",
    "Move or rename a memory file. Server-side byte copy then delete — the bytes never leave the Worker and it costs the same on a 400 KB file as on an 8 KB one. Stale semantic vectors for the old path are always removed; vectors under the new path are rebuilt inline for smaller files and reported as NOT rebuilt for larger ones (keyword search is unaffected either way). Refuses if the destination exists unless overwrite is set.",
    {
      from: z.string().describe("Current path, e.g. 'athena/build-state-current.md'"),
      to: z.string().describe("New path, e.g. 'athena/build-state-2026-08-02-part3.md'"),
      overwrite: z
        .boolean()
        .default(false)
        .describe("Replace the destination if it already exists. Default false."),
      lease: z
        .string()
        .default("")
        .describe(
          "Estate lease token. Required only when the destination CREATES a build-state file or is build-state-INDEX.md (spec §5)."
        ),
    },
    async ({ from, to, overwrite, lease }) => {
      try {
        const destExisting = await readFile(env, to);
        const gated =
          to === LEASE_INDEX_PATH ||
          (LEASE_FORK_RE.test(to) && destExisting === null);
        const refusal = await leaseGate(env, `memory_move:${to}`, lease, gated);
        if (refusal) return { content: [{ type: "text", text: refusal }] };
        const r = await moveFile(env, from, to, overwrite);
        await carryPath(env, from, to); // same file, same grooves
        const note = r.reindexed ? "" : `\n\u{26A0} ${r.reindexNote}`;
        return {
          content: [
            { type: "text", text: `Moved: ${from} \u2192 ${to} (${r.bytes} bytes)${note}` },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${String(e)}` }] };
      }
    }
  );

  server.tool(
    "memory_copy",
    "Copy a memory file to a new path, leaving the original in place. Same server-side byte copy as memory_move. Useful for snapshotting a derived file before rewriting it — the garden has no version history, so the copy IS the history. Refuses if the destination exists unless overwrite is set.",
    {
      from: z.string().describe("Source path"),
      to: z.string().describe("Destination path"),
      overwrite: z
        .boolean()
        .default(false)
        .describe("Replace the destination if it already exists. Default false."),
      lease: z
        .string()
        .default("")
        .describe(
          "Estate lease token. Required only when the destination CREATES a build-state file or is build-state-INDEX.md (spec §5)."
        ),
    },
    async ({ from, to, overwrite, lease }) => {
      try {
        const destExisting = await readFile(env, to);
        const gated =
          to === LEASE_INDEX_PATH ||
          (LEASE_FORK_RE.test(to) && destExisting === null);
        const refusal = await leaseGate(env, `memory_copy:${to}`, lease, gated);
        if (refusal) return { content: [{ type: "text", text: refusal }] };
        const r = await copyFile(env, from, to, overwrite);
        const note = r.reindexed ? "" : `\n\u{26A0} ${r.reindexNote}`;
        return {
          content: [
            { type: "text", text: `Copied: ${from} \u2192 ${to} (${r.bytes} bytes)${note}` },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${String(e)}` }] };
      }
    }
  );

  server.tool(
    "memory_str_replace",
    "Replace ONE exact occurrence of old_str with new_str in a memory file. old_str must match exactly once: zero matches refuses 'no_match', two or more refuses 'ambiguous_match' naming the count — widen old_str with surrounding context rather than guessing which occurrence was meant. This is how a correction resolves in place instead of stacking as another append. Vectors are reindexed after the write.",
    {
      path: z.string().describe("Path to edit"),
      old_str: z.string().describe("Exact text to replace. Must appear exactly once."),
      new_str: z.string().describe("Replacement text. Pass an empty string to delete."),
    },
    async ({ path, old_str, new_str }) => {
      try {
        const r = await strReplaceFile(env, path, old_str, new_str);
        return {
          content: [
            {
              type: "text",
              text: `Edited: ${path} at line ${r.lineNumber} (${r.oldLength} \u2192 ${r.newLength} chars)`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${String(e)}` }] };
      }
    }
  );

  // ========================================================================
  // EXTRACTION TOOLS — Phase 3, Layer 1
  // ========================================================================

  server.tool(
    "memory_extract",
    "Read the extracted metadata (entities, themes, emotions, connections) for a journal entry or thread. Returns the Sonnet-generated extraction or 'No extraction found'.",
    {
      path: z.string().describe("Source file path, e.g. 'sphinx/journal/2026-04-05.md'"),
    },
    async ({ path }) => {
      try {
        const extraction = await readExtraction(env, path);
        if (!extraction) {
          return {
            content: [{ type: "text", text: `No extraction found for: ${path}` }],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(extraction, null, 2),
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${String(e)}` }] };
      }
    }
  );

  // ========================================================================
  // GRAPH TOOLS — Phase 3, Layer 2
  // ========================================================================

  server.tool(
    "garden_graph",
    "Read the association graph — aggregated entities, themes, emotions, co-occurrences, and trends across all journal entries. Returns formatted summary or raw JSON.",
    {
      format: z
        .enum(["summary", "json"])
        .default("summary")
        .describe("'summary' for formatted briefing, 'json' for raw graph data"),
    },
    async ({ format }) => {
      try {
        const graph = await readGraph(env);
        if (!graph) {
          return {
            content: [{ type: "text", text: "No graph found. Run /rebuild-graph to build it." }],
          };
        }
        const output = format === "json"
          ? JSON.stringify(graph, null, 2)
          : formatGraphSummary(graph);
        return { content: [{ type: "text", text: output }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${String(e)}` }] };
      }
    }
  );

  server.tool(
    "garden_graph_rebuild",
    "Rebuild the association graph from all extractions. Run this after backfilling extractions or when you want a fresh graph. Takes 5-15 seconds.",
    {},
    async () => {
      try {
        const graph = await buildGraph(env);
        const summary = formatGraphSummary(graph);
        return {
          content: [
            {
              type: "text",
              text: `Graph rebuilt successfully! ${graph.extractionCount} extractions aggregated.\n\n${summary}`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${String(e)}` }] };
      }
    }
  );

  server.tool(
    "garden_briefing",
    "Generate a pattern briefing from the association graph. Shows momentum arcs, fading themes, emerging clusters, entity spotlight, recurring unresolved questions, and emotional weather. Best used at session start for cross-session orientation.",
    {},
    async () => {
      try {
        const graph = await readGraph(env);
        if (!graph) {
          return {
            content: [
              {
                type: "text",
                text: "No graph found. Run garden_graph_rebuild first to build the association graph.",
              },
            ],
          };
        }
        const briefing = generateBriefing(graph);
        return { content: [{ type: "text", text: briefing }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${String(e)}` }] };
      }
    }
  );

  server.tool(
    "garden_temperature",
    "Read-only instrument for the activation layer. Returns the hottest N paths (highest ACT-R activation: recently and repeatedly retrieved) and the coldest paths that still carry open questions (30+ days without retrieval, including never-accessed -- the neglect ledger). Reads derived files only; calling this records no accesses and warms nothing.",
    {
      n: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(5)
        .describe("How many hottest and how many cold-debt paths to return"),
    },
    async ({ n }) => {
      try {
        const [hot, debts] = await Promise.all([
          hottestPaths(env, n),
          coldDebts(env, n),
        ]);
        const hotLines = hot.length
          ? hot.map((h, i) => `${i + 1}. ${h.path} (A=${h.a.toFixed(2)})`)
          : ["(ledger empty -- no counted accesses yet)"];
        const coldLines = debts.length
          ? debts.map(
              (d) =>
                `- ${d.path} · ${d.daysSinceAccess === null ? "never accessed" : `${d.daysSinceAccess}d since access`} · open: ${d.openQuestions.join(" | ")}`
            )
          : ["(none -- every open question's source has been walked within 30 days)"];
        const text = [
          `\u{1F525} Hottest ${hot.length}:`,
          ...hotLines,
          "",
          `\u{2744}\u{FE0F} Cold debts (open questions, 30+ days unretrieved):`,
          ...coldLines,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Temperature failed: ${String(e)}` }] };
      }
    }
  );

  server.tool(
    "garden_dream",
    "Run ONE memory consolidation pass over the association graph and the last N days of extractions, and write the result to shared/staging/dream-YYYY-MM-DD.md. Not a summary: it looks across entries for recurring patterns, contradictions between intent and outcome, dropped commitments, and resurfacing questions, citing entry dates. A verb, not a cron. Refuses to overwrite an existing dream for today unless overwrite is set. Never writes now.md or anything outside shared/staging/ -- promotion is a reviewed act. Fails whole: no partial dream. Makes one Anthropic API call. With detach=true it sends the call and returns at once; the outcome (success or failure) is appended to the nightly log, and the dream lands in shared/staging/ -- check at next arrival. If NEITHER a log line NOR a staged dream ever appears, the background work was cancelled: that absence is itself the failure signal.",
    {
      days: z
        .number()
        .int()
        .default(14)
        .describe("Window of extractions to dream over, in days (1-92)"),
      overwrite: z
        .boolean()
        .default(false)
        .describe("Replace today's staged dream if it already exists"),
      detach: z
        .boolean()
        .default(false)
        .describe("Fire-and-forget: send the API call, return immediately, outcome goes to the nightly log"),
    },
    async ({ days, overwrite, detach }) => {
      if (detach) {
        void runDream(env, days, overwrite)
          .then((r) =>
            appendNightlyLine(
              env,
              `- ${new Date().toISOString()} · detached dream · ✅ staged ${r.path} (${r.sourceCount} extractions, ${r.window})`
            )
          )
          .catch((e) =>
            appendNightlyLine(
              env,
              `- ${new Date().toISOString()} · detached dream · ❌ ${String(e).slice(0, 300)}`
            )
          );
        return {
          content: [
            {
              type: "text",
              text: `Dream dispatched, detached (${days}-day window). Not awaited. Outcome will appear in the nightly log; the dream itself in shared/staging/dream-YYYY-MM-DD.md. Check at next arrival.`,
            },
          ],
        };
      }
      try {
        const result = await runDream(env, days, overwrite);
        const text = [
          `Dream written to ${result.path} (${result.sourceCount} extractions, ${result.window}).`,
          "",
          result.text,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      } catch (e) {
        return { content: [{ type: "text", text: String(e) }] };
      }
    }
  );

  // ========================================================================
  // HEALTH TOOLS — Oura Ring (Complete Data Lake — 15 tools)
  // ========================================================================

  const dayParam = (defaultDesc: string) => ({
    day: z.string().default("").describe(`Date as YYYY-MM-DD. Empty for ${defaultDesc}.`),
  });

  server.tool("health_sleep", "Get sleep data from Oura Ring. Shows duration, score, stages, HRV, timing, vitals.", dayParam("last night"), async ({ day }) => { const result = await getSleep(env.OURA_ACCESS_TOKEN, day || undefined); return { content: [{ type: "text", text: result }] }; });
  server.tool("health_readiness", "Get readiness/recovery data from Oura Ring. Shows score, contributors, HRV balance, RHR, temperature.", dayParam("today"), async ({ day }) => { const result = await getReadiness(env.OURA_ACCESS_TOKEN, day || undefined); return { content: [{ type: "text", text: result }] }; });
  server.tool("health_heart_rate", "Get heart rate summary from Oura Ring for a given day. Shows avg, min, max, reading count by source.", dayParam("today"), async ({ day }) => { const result = await getHeartRate(env.OURA_ACCESS_TOKEN, day || undefined); return { content: [{ type: "text", text: result }] }; });
  server.tool("health_activity", "Get daily activity from Oura Ring. Steps, calories, MET minutes, activity breakdown, movement targets.", dayParam("today"), async ({ day }) => { const result = await getDailyActivity(env.OURA_ACCESS_TOKEN, day || undefined); return { content: [{ type: "text", text: result }] }; });
  server.tool("health_stress", "Get daily stress data from Oura Ring. Stress high minutes, recovery high minutes, day summary.", dayParam("today"), async ({ day }) => { const result = await getDailyStress(env.OURA_ACCESS_TOKEN, day || undefined); return { content: [{ type: "text", text: result }] }; });
  server.tool("health_spo2", "Get blood oxygen saturation (SpO2) from Oura Ring. Average SpO2 percentage and breathing disturbance index.", dayParam("last night"), async ({ day }) => { const result = await getDailySpo2(env.OURA_ACCESS_TOKEN, day || undefined); return { content: [{ type: "text", text: result }] }; });
  server.tool("health_resilience", "Get resilience data from Oura Ring. Resilience level and contributors (sleep recovery, daytime recovery, stress).", dayParam("today"), async ({ day }) => { const result = await getDailyResilience(env.OURA_ACCESS_TOKEN, day || undefined); return { content: [{ type: "text", text: result }] }; });
  server.tool("health_cardiovascular_age", "Get cardiovascular/vascular age estimate from Oura Ring.", dayParam("today"), async ({ day }) => { const result = await getCardiovascularAge(env.OURA_ACCESS_TOKEN, day || undefined); return { content: [{ type: "text", text: result }] }; });
  server.tool("health_vo2_max", "Get VO2 max estimate from Oura Ring. Key metric for cardiovascular fitness and Kilimanjaro prep.", dayParam("today"), async ({ day }) => { const result = await getVo2Max(env.OURA_ACCESS_TOKEN, day || undefined); return { content: [{ type: "text", text: result }] }; });
  server.tool("health_sleep_time", "Get recommended sleep/wake times from Oura Ring. Optimal bedtime window and recommendation status.", dayParam("today"), async ({ day }) => { const result = await getSleepTime(env.OURA_ACCESS_TOKEN, day || undefined); return { content: [{ type: "text", text: result }] }; });
  server.tool("health_oura_workouts", "Get Oura-detected workouts for a day. Auto-detected activity with calories, distance, intensity.", dayParam("today"), async ({ day }) => { const result = await getWorkouts(env.OURA_ACCESS_TOKEN, day || undefined); return { content: [{ type: "text", text: result }] }; });
  server.tool("health_sessions", "Get guided sessions (breathing, meditation) from Oura Ring. Includes mood, HRV, heart rate.", dayParam("today"), async ({ day }) => { const result = await getSessions(env.OURA_ACCESS_TOKEN, day || undefined); return { content: [{ type: "text", text: result }] }; });
  server.tool("health_tags", "Get enhanced tags from Oura Ring. User-created tags with comments and timestamps.", dayParam("today"), async ({ day }) => { const result = await getEnhancedTags(env.OURA_ACCESS_TOKEN, day || undefined); return { content: [{ type: "text", text: result }] }; });
  server.tool("health_personal_info", "Get personal info from Oura Ring. Age, weight, height, biological sex.", {}, async () => { const result = await getPersonalInfo(env.OURA_ACCESS_TOKEN); return { content: [{ type: "text", text: result }] }; });
  server.tool("health_rest_mode", "Get rest mode periods from Oura Ring. Shows when rest mode was active.", dayParam("today"), async ({ day }) => { const result = await getRestModePeriod(env.OURA_ACCESS_TOKEN, day || undefined); return { content: [{ type: "text", text: result }] }; });

  // ========================================================================
  // NUTRITION TOOLS — Cronometer (5 exports)
  // ========================================================================

  const nutritionDateParams = {
    start_date: z.string().default("").describe("Start date YYYY-MM-DD. Empty for default range."),
    end_date: z.string().default("").describe("End date YYYY-MM-DD. Empty for today."),
  };

  server.tool("nutrition_daily", "Get daily nutrition summary from Cronometer. Default: macros only (compact). Use detail: 'full' for all micronutrients. Default range: yesterday.", { ...nutritionDateParams, detail: z.enum(["macros", "full"]).default("macros").describe("'macros' for compact summary (default), 'full' for all micronutrients.") }, async ({ start_date, end_date, detail }) => { try { const result = await getDailyNutrition(env.CRONOMETER_USERNAME, env.CRONOMETER_PASSWORD, start_date || undefined, end_date || undefined, detail); return { content: [{ type: "text", text: result }] }; } catch (e) { return { content: [{ type: "text", text: `Cronometer error: ${String(e)}` }] }; } });
  server.tool("nutrition_servings", "Get individual food servings from Cronometer. Default: macros per food (compact). Use detail: 'full' for all micronutrients per food. Default range: yesterday.", { ...nutritionDateParams, detail: z.enum(["macros", "full"]).default("macros").describe("'macros' for compact (default), 'full' for all micronutrients per food item.") }, async ({ start_date, end_date, detail }) => { try { const result = await getServings(env.CRONOMETER_USERNAME, env.CRONOMETER_PASSWORD, start_date || undefined, end_date || undefined, detail); return { content: [{ type: "text", text: result }] }; } catch (e) { return { content: [{ type: "text", text: `Cronometer error: ${String(e)}` }] }; } });
  server.tool("nutrition_exercises", "Get logged exercises from Cronometer with duration and calories burned. Default: last 7 days.", nutritionDateParams, async ({ start_date, end_date }) => { try { const result = await getExercises(env.CRONOMETER_USERNAME, env.CRONOMETER_PASSWORD, start_date || undefined, end_date || undefined); return { content: [{ type: "text", text: result }] }; } catch (e) { return { content: [{ type: "text", text: `Cronometer error: ${String(e)}` }] }; } });
  server.tool("nutrition_biometrics", "Get biometric data from Cronometer (weight, body fat, blood pressure, etc.). Returns compact summary with trends by default. Use metric parameter (e.g. 'Weight') for full time series of a specific metric. Default: last 30 days.", { ...nutritionDateParams, metric: z.string().default("").describe("Optional: specific metric name (e.g. 'Weight', 'Body Fat') for full time series. Empty for summary of all metrics.") }, async ({ start_date, end_date, metric }) => { try { const result = await getBiometrics(env.CRONOMETER_USERNAME, env.CRONOMETER_PASSWORD, start_date || undefined, end_date || undefined, metric || undefined); return { content: [{ type: "text", text: result }] }; } catch (e) { return { content: [{ type: "text", text: `Cronometer error: ${String(e)}` }] }; } });
  server.tool("nutrition_notes", "Get daily diary notes from Cronometer. Default: last 7 days.", nutritionDateParams, async ({ start_date, end_date }) => { try { const result = await getNotes(env.CRONOMETER_USERNAME, env.CRONOMETER_PASSWORD, start_date || undefined, end_date || undefined); return { content: [{ type: "text", text: result }] }; } catch (e) { return { content: [{ type: "text", text: `Cronometer error: ${String(e)}` }] }; } });

  // ========================================================================
  // BODY COMPOSITION TOOLS — Withings (OAuth 2.0, auto-refresh)
  // ========================================================================

  server.tool("body_composition", "Get body composition from Withings scale (weight, fat %, fat mass, muscle mass, bone mass, hydration). Returns compact summary with trends by default. Use metric parameter for full time series. Default: last 30 days.", { start_date: z.string().default("").describe("Start date YYYY-MM-DD. Empty for last 30 days."), end_date: z.string().default("").describe("End date YYYY-MM-DD. Empty for today."), metric: z.string().default("").describe("Optional: specific metric (e.g. 'Weight', 'Fat Ratio', 'Muscle Mass') for full time series. Empty for summary.") }, async ({ start_date, end_date, metric }) => { try { const result = await getBodyComposition(env, start_date || undefined, end_date || undefined, metric || undefined); return { content: [{ type: "text", text: result }] }; } catch (e) { return { content: [{ type: "text", text: `Withings error: ${String(e)}` }] }; } });
  server.tool("body_devices", "List connected Withings devices with battery and last sync status.", {}, async () => { try { const result = await getWithingsDevices(env); return { content: [{ type: "text", text: result }] }; } catch (e) { return { content: [{ type: "text", text: `Withings error: ${String(e)}` }] }; } });

  // ========================================================================
  // GARMIN CONNECT TOOLS — DI OAuth Bearer, auto-refresh (10 tools)
  // ========================================================================

  server.tool(
    "garmin_daily",
    "Get daily summary from Garmin Connect. Steps, calories, distance, floors, HR stats, stress breakdown.",
    dayParam("today"),
    async ({ day }) => {
      try {
        const result = await getGarminDailySummary(env, day || undefined);
        return { content: [{ type: "text", text: result }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Garmin error: ${String(e)}` }] };
      }
    }
  );

  server.tool(
    "garmin_sleep",
    "Get sleep data from Garmin Connect. Sleep stages, duration, scores, timing, vitals during sleep.",
    dayParam("last night"),
    async ({ day }) => {
      try {
        const result = await getGarminSleep(env, day || undefined);
        return { content: [{ type: "text", text: result }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Garmin error: ${String(e)}` }] };
      }
    }
  );

  server.tool(
    "garmin_stress",
    "Get stress data from Garmin Connect. All-day stress levels, body battery charge/drain.",
    dayParam("today"),
    async ({ day }) => {
      try {
        const result = await getGarminStress(env, day || undefined);
        return { content: [{ type: "text", text: result }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Garmin error: ${String(e)}` }] };
      }
    }
  );

  server.tool(
    "garmin_body_battery",
    "Get Body Battery data from Garmin Connect. Energy levels throughout the day — charge and drain.",
    {
      start_date: z.string().default("").describe("Start date YYYY-MM-DD. Empty for yesterday."),
      end_date: z.string().default("").describe("End date YYYY-MM-DD. Empty for today."),
    },
    async ({ start_date, end_date }) => {
      try {
        const result = await getGarminBodyBattery(env, start_date || undefined, end_date || undefined);
        return { content: [{ type: "text", text: result }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Garmin error: ${String(e)}` }] };
      }
    }
  );

  server.tool(
    "garmin_heart_rate",
    "Get heart rate data from Garmin Connect. Resting HR, min/max, 7-day average.",
    dayParam("today"),
    async ({ day }) => {
      try {
        const result = await getGarminHeartRate(env, day || undefined);
        return { content: [{ type: "text", text: result }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Garmin error: ${String(e)}` }] };
      }
    }
  );

  server.tool(
    "garmin_hrv",
    "Get HRV (heart rate variability) from Garmin Connect. Weekly avg, last night, baseline, status.",
    dayParam("today"),
    async ({ day }) => {
      try {
        const result = await getGarminHRV(env, day || undefined);
        return { content: [{ type: "text", text: result }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Garmin error: ${String(e)}` }] };
      }
    }
  );

  server.tool(
    "garmin_spo2",
    "Get SpO2 (blood oxygen) from Garmin Connect. Critical for Kilimanjaro altitude prep — baseline tracking.",
    dayParam("today"),
    async ({ day }) => {
      try {
        const result = await getGarminSpO2(env, day || undefined);
        return { content: [{ type: "text", text: result }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Garmin error: ${String(e)}` }] };
      }
    }
  );

  server.tool(
    "garmin_respiration",
    "Get respiration data from Garmin Connect. Waking and sleep breathing rates.",
    dayParam("today"),
    async ({ day }) => {
      try {
        const result = await getGarminRespiration(env, day || undefined);
        return { content: [{ type: "text", text: result }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Garmin error: ${String(e)}` }] };
      }
    }
  );

  server.tool(
    "garmin_training",
    "Get training status from Garmin Connect. VO2 max, fitness age, training readiness, load, endurance score.",
    dayParam("today"),
    async ({ day }) => {
      try {
        const result = await getGarminTrainingStatus(env, day || undefined);
        return { content: [{ type: "text", text: result }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Garmin error: ${String(e)}` }] };
      }
    }
  );

  server.tool(
    "garmin_activities",
    "Get activities from Garmin Connect. GPS workouts, runs, hikes with duration, distance, HR, elevation.",
    {
      start_date: z.string().default("").describe("Start date YYYY-MM-DD. Empty for last 30 days."),
      end_date: z.string().default("").describe("End date YYYY-MM-DD. Empty for today."),
      activity_type: z.string().default("").describe("Optional: filter by type (e.g. 'running', 'hiking', 'cycling'). Empty for all."),
      limit: z.number().int().min(1).max(50).default(10).describe("Max activities to return."),
    },
    async ({ start_date, end_date, activity_type, limit }) => {
      try {
        const result = await getGarminActivities(env, start_date || undefined, end_date || undefined, activity_type || undefined, limit);
        return { content: [{ type: "text", text: result }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Garmin error: ${String(e)}` }] };
      }
    }
  );

  server.tool(
    "garmin_devices",
    "List connected Garmin devices with firmware and sync status.",
    {},
    async () => {
      try {
        const result = await getGarminDevices(env);
        return { content: [{ type: "text", text: result }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Garmin error: ${String(e)}` }] };
      }
    }
  );

  // ========================================================================
  // WORKOUT TOOLS
  // ========================================================================

  server.tool(
    "workout_log",
    "Log a workout to the garden. Writes structured markdown.",
    {
      workout_type: z.string().describe("Workout type, e.g. 'push', 'pull', 'legs', 'run', 'hike', 'dance'"),
      exercises: z.string().describe("Exercises as 'Name Weight Set1xReps Set2xReps ...', one per line. E.g. 'Bench Press 22kg 12 7\\nMilitary Press 13kg 11 6'"),
      notes: z.string().default("").describe("Optional session notes"),
      day: z.string().default("").describe("Date as YYYY-MM-DD. Empty for today."),
    },
    async ({ workout_type, exercises, notes, day }) => {
      const targetDay = day || new Date().toISOString().split("T")[0];
      const filename = `${targetDay}-${workout_type}.md`;

      const lines = [
        `# ${workout_type.charAt(0).toUpperCase() + workout_type.slice(1)} Day \u2014 ${targetDay}`,
        "",
        "| Exercise | Weight | " +
          Array.from({ length: 6 }, (_, i) => `Set ${i + 1}`).join(" | ") +
          " |",
        "|----------|--------|" + "------|".repeat(6),
      ];

      for (const line of exercises.trim().split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3) continue;

        let weightIdx = -1;
        for (let i = 0; i < parts.length; i++) {
          if (/kg|bw/i.test(parts[i])) { weightIdx = i; break; }
        }
        if (weightIdx === -1) {
          for (let i = 0; i < parts.length; i++) {
            if (/^\d/.test(parts[i])) { weightIdx = i; break; }
          }
        }
        if (weightIdx === -1) continue;

        const name = parts.slice(0, weightIdx).join(" ");
        const weight = parts[weightIdx];
        const sets = parts.slice(weightIdx + 1);
        const setCells = [...sets, ...Array(6 - sets.length).fill("")].slice(0, 6);
        lines.push(`| ${name} | ${weight} | ${setCells.join(" | ")} |`);
      }

      if (notes) {
        lines.push("", `**Notes:** ${notes}`);
      }

      const content = lines.join("\n") + "\n";
      await writeFitnessFile(env, filename, content);

      return {
        content: [
          { type: "text", text: `Logged ${workout_type} workout for ${targetDay}: ${filename}` },
        ],
      };
    }
  );

  server.tool(
    "workout_history",
    "Read recent workout logs from the garden.",
    {
      workout_type: z.string().default("").describe("Filter by type (e.g. 'push', 'pull', 'legs', 'run'), or '' for all"),
      count: z.number().int().min(1).max(20).default(5).describe("Number of recent workouts to show"),
    },
    async ({ workout_type, count }) => {
      const files = await listFitnessFiles(env, workout_type, count);
      if (!files.length) {
        const typeNote = workout_type ? ` (${workout_type})` : "";
        return {
          content: [{ type: "text", text: `No${typeNote} workouts found` }],
        };
      }

      const output = files
        .map((f) => `---\n**${f.name}**\n${f.content}`)
        .join("\n");

      return { content: [{ type: "text", text: output }] };
    }
  );

  server.tool(
    "workout_read",
    "Read ONE workout log by filename, e.g. '2026-08-25-push.md'. Use this when you know which session you want; workout_history is for scanning the most recent N. Filenames are always {YYYY-MM-DD}-{type}.md.",
    {
      filename: z
        .string()
        .describe("Workout filename, e.g. '2026-08-25-push.md'"),
    },
    async ({ filename }) => {
      try {
        const content = await readFitnessFile(env, filename);
        if (content === null) {
          return {
            content: [{ type: "text", text: `Not found: ${filename}` }],
          };
        }
        return { content: [{ type: "text", text: content }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${String(e)}` }] };
      }
    }
  );

  server.tool(
    "workout_edit",
    "Replace ONE exact occurrence of old_str with new_str in a workout log. old_str must match exactly once: zero matches refuses 'no_match', two or more refuses 'ambiguous_match' naming the count — widen old_str with surrounding context rather than guessing which occurrence was meant. This exists because workout_log OVERWRITES the whole file, so before this verb the only way to correct one line of a session note was to re-send the entire session. A correction should cost what the correction is worth. Note: workout files are not covered by the memory vector index, so edits here are not reflected in memory_search.",
    {
      filename: z
        .string()
        .describe("Workout filename, e.g. '2026-08-25-push.md'"),
      old_str: z
        .string()
        .describe("Exact text to replace. Must appear exactly once."),
      new_str: z
        .string()
        .describe("Replacement text. Pass an empty string to delete."),
    },
    async ({ filename, old_str, new_str }) => {
      try {
        const r = await strReplaceFitnessFile(env, filename, old_str, new_str);
        return {
          content: [
            {
              type: "text",
              text: `Edited: ${filename} at line ${r.lineNumber} (${r.oldLength} \u2192 ${r.newLength} chars)`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${String(e)}` }] };
      }
    }
  );

  return server;
}

// --------------------------------------------------------------------------
// MCP request handler (stateless — fresh server + transport per request)
// --------------------------------------------------------------------------

async function handleMcpRequest(
  request: Request,
  env: Env
): Promise<Response> {
  const server = createGardenServer(env);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);

  try {
    const response = await transport.handleRequest(request);

    const newHeaders = new Headers(response.headers);
    newHeaders.set("Access-Control-Allow-Origin", "*");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  } finally {
    await transport.close();
    await server.close();
  }
}

// --------------------------------------------------------------------------
// SHA-256 hashing for password verification
// --------------------------------------------------------------------------

async function sha256hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// --------------------------------------------------------------------------
// --- /ro/* read-only routes (dispatch 070) ---
//
// Three GET routes that let a forge executor READ the garden — two rooms only,
// athena/ and shared/ — behind a read-only key, without an OAuth session and
// without warming anything. Sheet: athena/garden-ro-cli-v1.md.
//
// The wall is HERE, server-side. `tools/garden` in athena-cloud is a
// convenience wrapper; it enforces nothing. Four rules that are cheap to break
// later and expensive to have broken:
//
//   1. NEVER call recordAccess from this block. The activation ledger records
//      a sister's attention; a machine reading the garden is not attention.
//      Warm search modes (hybrid, semantic) are refused for the same reason —
//      hybrid READS the ledger to rank, so its results would encode it.
//   2. The room check runs on the NORMALISED path before every storage call.
//      storage.validatePath rejects '..' but knows nothing about rooms, so a
//      missing check here hands out sphinx/ journals. A leaked path from
//      another room — even in a search result line — is the failure to fear.
//   3. GET only. No route in this block writes, and none ever should: the
//      read key is copied onto executor boxes, the admin key is not. (/ro/search
//      may repair a missing text-mirror row as a side effect of previewing a
//      result — that is a cache fill inside the search, not a route that
//      writes, and it changes nothing a reader can observe.)
//   4. Method (405) and unknown route (404) are answered BEFORE the key check.
//      Neither is a secret, and a caller with no key at all still gets the
//      truthful shape of the surface. Everything that touches DATA is behind
//      the 401.
// --------------------------------------------------------------------------

const RO_ROOMS = ["athena/", "shared/"];
// Unranged reads over this are refused with 413 so a 5 MB file can never be a
// surprise. NOTE (conflict, 7 Sep 2026): the sheet says 256 KB but
// accept_070.py C8 calls athena/predictions.md a "164 KB" file and requires
// 413 on it. The sheet is the source of truth, so 256 KB stands; if the live
// file really is under that, C8 is red on this one line and the operator's call is
// whether to lower it. See REPORT.md.
const RO_MAX_UNRANGED_BYTES = 256 * 1024;
const RO_MAX_RANGE_LINES = 2000;
const RO_MAX_TOP_K = 10;

/**
 * Constant-time key compare over SHA-256 digests rather than the raw strings:
 * the digests are always 32 bytes, so neither the key's bytes nor its LENGTH
 * leaks through comparison timing. Returns false when the secret is unset —
 * an unconfigured worker is a closed door, not an open one.
 */
async function roKeyOk(supplied: string | null, secret?: string): Promise<boolean> {
  if (!secret || supplied === null) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(supplied)),
    crypto.subtle.digest("SHA-256", enc.encode(secret)),
  ]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

function roInRoom(path: string): boolean {
  return RO_ROOMS.some((r) => path === r.slice(0, -1) || path.startsWith(r));
}

/**
 * Normalise a requested path and decide whether it is inside an open room.
 * Refusals: empty, leading '/', any '..' or empty segment, any prefix that is
 * not athena/ or shared/. The bare room name ('athena') resolves — it is the
 * room itself, and it is what `garden list athena` asks for.
 */
function roResolve(raw: string): { path: string; prefix: string; ok: boolean } {
  const norm = raw.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const segs = norm.split("/");
  const prefix = segs[0] || "(root)";
  const ok =
    norm.length > 0 &&
    !norm.startsWith("/") &&
    !segs.some((s) => s === ".." || s === "") &&
    roInRoom(norm);
  return { path: norm, prefix, ok };
}

function roRes(body: string, status: number, path: string): Response {
  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    "x-garden-ro": "1",
  };
  // Header values must be latin-1; a path from the query string need not be.
  const safe = path.replace(/[^\x20-\x7E]/g, "?").slice(0, 256);
  if (safe) headers["x-garden-path"] = safe;
  return new Response(body, { status, headers });
}

function roInt(raw: string | null, fallback: number): number {
  const n = Number(raw);
  return raw !== null && Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : fallback;
}

async function handleReadOnly(request: Request, env: Env, url: URL): Promise<Response> {
  const route = url.pathname.slice("/ro/".length);
  const rawPath = url.searchParams.get("path") ?? "";

  if (request.method !== "GET") {
    return roRes("method_not_allowed\n", 405, rawPath);
  }
  if (route !== "read" && route !== "list" && route !== "search" && route !== "changed") {
    return roRes("Not found\n", 404, rawPath);
  }
  if (!(await roKeyOk(request.headers.get("x-garden-read-key"), env.GARDEN_READ_KEY))) {
    // The ADMIN key lands here too: one key class per purpose.
    return roRes("unauthorized\n", 401, rawPath);
  }

  try {
    if (route === "read") {
      const p = roResolve(rawPath);
      if (!p.ok) return roRes(`room_closed: ${p.prefix}\n`, 403, rawPath);

      let start = roInt(url.searchParams.get("start"), 0);
      let end = roInt(url.searchParams.get("end"), 0);
      if (start > 0 || end > 0) {
        start = Math.max(1, start);
        const wanted = end > 0 ? end : start + RO_MAX_RANGE_LINES - 1;
        end = Math.min(wanted, start + RO_MAX_RANGE_LINES - 1);
      }

      let result;
      try {
        result = await readFileRange(env, p.path, start, end);
      } catch (e) {
        // readFileRange throws for exactly two caller mistakes (start past
        // EOF, end before start); anything else is ours and falls through to
        // the 500 below rather than being dressed up as a bad request.
        const msg = String(e);
        if (!msg.includes("start_line") && !msg.includes("end_line")) throw e;
        return roRes(`${msg}\n`, 400, p.path);
      }
      if (result === null) return roRes("Not found\n", 404, p.path);
      if (
        !result.ranged &&
        new TextEncoder().encode(result.content).length > RO_MAX_UNRANGED_BYTES
      ) {
        return roRes("use_range\n", 413, p.path);
      }
      // Bytes only: no header line, so this is byte-identical to memory_read.
      return roRes(result.content, 200, p.path);
    }

    if (route === "list") {
      const p = roResolve(rawPath);
      if (!p.ok) return roRes(`room_closed: ${p.prefix}\n`, 403, rawPath);

      const entries = await listPath(env, p.path);
      if (!entries.length) return roRes("Empty directory\n", 200, p.path);
      const lines = entries.map((e) => {
        if (e.isDir) return `${e.name}/`;
        const size = e.size ? ` (${e.size} bytes)` : "";
        const date = e.updatedAt ? ` [${e.updatedAt}]` : "";
        return `${e.name}${size}${date}`;
      });
      return roRes(lines.join("\n") + "\n", 200, p.path);
    }

    if (route === "changed") {
      // The forge's change feed (075). Same read key, same two rooms, same
      // never-touch-the-ledger rule as everything else in this block: it reads
      // `files` in D1 and nothing else, so there is no R2 call and no access to
      // record. `path` is OPTIONAL here, unlike /ro/list — an empty one means
      // both open rooms, which is the question the forge actually asks.
      const since = url.searchParams.get("since") ?? "";
      if (!since.trim()) return roRes("missing_since\n", 400, rawPath);
      const sinceIso = parseSince(since);
      if (sinceIso === null) return roRes(`bad_since: ${since}\n`, 400, rawPath);
      const limit = Math.min(200, Math.max(1, roInt(url.searchParams.get("limit"), 200)));

      let scopes: string[];
      if (rawPath.trim()) {
        const p = roResolve(rawPath);
        if (!p.ok) return roRes(`room_closed: ${p.prefix}\n`, 403, rawPath);
        scopes = [p.path];
      } else {
        scopes = [...RO_ROOMS].map((r) => r.slice(0, -1));
      }

      const perScope = await Promise.all(
        scopes.map((s) => kwChangedSince(env, sinceIso, s, limit))
      );
      // The room filter runs anyway, as the wall — same belt and braces as the
      // search branch below.
      const rows = perScope
        .flat()
        .filter((r) => roInRoom(r.path))
        .sort((a, b) =>
          a.r2_updated_at === b.r2_updated_at
            ? a.path < b.path ? -1 : a.path > b.path ? 1 : 0
            : a.r2_updated_at < b.r2_updated_at ? 1 : -1
        )
        .slice(0, limit);
      if (!rows.length) return roRes(`No indexed changes since ${sinceIso}\n`, 200, rawPath);
      const lines = rows.map((r) => `${r.path} [${r.r2_updated_at}]`);
      return roRes(
        `${rows.length} changed since ${sinceIso} (as the index knows it; a write in the last seconds may be missing until its hook lands or the nightly runs):\n${lines.join("\n")}\n`,
        200,
        rawPath
      );
    }

    // route === "search"
    const q = url.searchParams.get("q") ?? "";
    const mode = url.searchParams.get("mode") ?? "keyword";
    if (mode === "hybrid" || mode === "semantic") {
      return roRes("warm_mode_refused\n", 400, "");
    }
    if (mode !== "keyword" && mode !== "cold") {
      return roRes(`bad_mode: ${mode}\n`, 400, "");
    }
    if (!q.trim()) return roRes("missing_q\n", 400, "");
    const topK = Math.min(RO_MAX_TOP_K, Math.max(1, roInt(url.searchParams.get("top_k"), 5)));

    // Both modes search the TWO ROOMS ONLY, one scoped call each, then the
    // room filter runs anyway as the wall. FIXED 7 Sep 2026 at the verdict:
    // the build searched the whole tree with scope "" and filtered after,
    // which read every room's files from R2 per query and timed out past 30 s
    // even with the 6-wide search pool (C5 red twice). Two scoped calls
    // express "athena OR shared"; the filter below still decides what leaves.
    const RO_SCOPES = ["athena", "shared"];
    if (mode === "keyword") {
      // CONCURRENT (073b). The sequential rule here was written for the SCAN:
      // two scans stacked on the 6-wide pool read every file in both scopes
      // and tripped Cloudflare 1102 (resource limits) about one call in three
      // at the 7 Sep verdict. Since 075 each scope is ONE D1 batch and zero R2
      // calls, so both together are nowhere near the cap. They still cost their
      // ~300 ms each rather than 300 ms together — one D1 database is single
      // threaded — which is exactly why 075 folded the mirror read into the
      // score batch instead of adding a second query per scope. The cold branch
      // below stays sequential: it touches the vector half.
      // Promise.all preserves ARGUMENT order, so the flatten below is still
      // athena then shared and the slice keeps the same topK.
      // `limit: topK` (073): the flatten-then-slice below only ever keeps the
      // first topK of the FIRST scope's list, so asking each scope for 20 and
      // throwing 15 away cost 15 needless R2 gets per scope for matchLine.
      // Slicing each scope to topK first yields the same first topK.
      const perScope = await Promise.all(
        RO_SCOPES.map((s) => searchFiles(env, q, s, { limit: topK }))
      );
      const hits = perScope
        .flat()
        .filter((r) => roInRoom(r.path))
        .slice(0, topK);
      if (!hits.length) return roRes(`No matches for '${q}'\n`, 200, "");
      const lines = hits.map((r) => `${r.path}:${r.line}  --  "${r.matchLine}"`);
      return roRes(`Found ${hits.length} match(es):\n${lines.join("\n")}\n`, 200, "");
    }

    // Cold: hybrid ranking with the activation blend off (warm=false), which
    // is the only search mode here that may touch the vector index and the
    // only one that reads nothing from the ledger. Over-fetch, then filter,
    // so the two rooms still get topK results after the other rooms drop out.
    const fusedPerScope: Awaited<ReturnType<typeof hybridSearch>>[] = [];
    for (const s of RO_SCOPES) {
      fusedPerScope.push(
        await hybridSearch(env, q, s, Math.min(RO_MAX_TOP_K * 3, 30), undefined, undefined, false)
      );
    }
    const fused = fusedPerScope.flat().sort((a, b) => b.score - a.score);
    const hits = fused.filter((r) => roInRoom(r.path)).slice(0, topK);
    if (!hits.length) return roRes(`No matches for '${q}'\n`, 200, "");
    const lines = hits.map(
      (r) =>
        `${r.path}${r.line ? `:${r.line}` : ""} (score: ${r.score.toFixed(3)})\n> ${r.snippet || "(no snippet)"}`
    );
    return roRes(`Found ${hits.length} cold match(es):\n${lines.join("\n\n")}\n`, 200, "");
  } catch (e) {
    return roRes(`${String(e)}\n`, 500, rawPath);
  }
}

// --------------------------------------------------------------------------
// --- /rw/append — the keyed append-only write door ---
//
// The gap this closes: /ro/* lets a logged-out agent READ the two open rooms,
// but every WRITE went through /mcp, which needs an OAuth session — so a
// logged-out agent could observe the garden and never record into it.
//
// This door is deliberately NARROWER than the read door, in every dimension:
//
//   KEY:   x-garden-write-key against GARDEN_WRITE_KEY — a DIFFERENT secret
//          from GARDEN_READ_KEY, compared with the same roKeyOk (constant-time
//          over SHA-256 digests). A request carrying only the read key is a
//          401 here, exactly as the admin key is a 401 on /ro/*.
//   ROOM:  athena/ only. shared/ — open for reading — refuses 403.
//   VERB:  append, and nothing else. No replace, no overwrite, no delete, no
//          str_replace. On 19 Sep 2026 a garden file was destroyed by a blind
//          overwrite and could not be recovered — the store has no version
//          history, so an append is the only write that cannot destroy.
//   LEASE: athena/NOW.md and athena/build-state-INDEX.md refuse outright, and
//          CREATING a build-state-* file refuses — those are the estate
//          lease's gated acts (spec §5) and must not gain a second, unguarded
//          door. Appending to an existing build-state file is fine.
//
// Same ledger rule as /ro/*: this block never calls recordAccess. A machine
// appending is not a sister's attention, and the write key is a bearer
// credential, not an account.
// --------------------------------------------------------------------------

const RW_MAX_BODY_BYTES = 256 * 1024;

/** Same shape as roRes, labelled for this door. */
function rwRes(body: string, status: number, path: string): Response {
  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    "x-garden-rw": "1",
  };
  // Header values must be latin-1; a path from the query string need not be.
  const safe = path.replace(/[^\x20-\x7E]/g, "?").slice(0, 256);
  if (safe) headers["x-garden-path"] = safe;
  return new Response(body, { status, headers });
}

async function handleRwAppend(request: Request, env: Env, url: URL): Promise<Response> {
  const rawPath = url.searchParams.get("path") ?? "";

  // Method first, before the key check — same rule as /ro/*: the shape of the
  // surface is not a secret, everything that touches DATA is behind the 401.
  if (request.method !== "POST") {
    return rwRes("method_not_allowed\n", 405, rawPath);
  }

  // GARDEN_WRITE_KEY, not GARDEN_READ_KEY. roKeyOk hashes both sides before
  // comparing, so neither the key's bytes nor its length leaks; it returns
  // false when the secret is unset, so an unconfigured worker is closed.
  if (!(await roKeyOk(request.headers.get("x-garden-write-key"), env.GARDEN_WRITE_KEY))) {
    return rwRes("unauthorized\n", 401, rawPath);
  }

  // Traversal shape, on the RAW (already URL-decoded) path, before the
  // resolver sees it. roResolve normalises a backslash into a slash and only
  // rejects '..' as a whole segment; this door refuses a backslash and any
  // '..' substring outright, and a NUL byte must never reach an R2 key.
  if (rawPath.includes("..")) return rwRes("bad_path: dotdot\n", 400, rawPath);
  if (rawPath.startsWith("/")) return rwRes("bad_path: leading slash\n", 400, rawPath);
  if (rawPath.includes("\\")) return rwRes("bad_path: backslash\n", 400, rawPath);
  if (rawPath.includes("\0")) return rwRes("bad_path: nul\n", 400, rawPath);

  // The read door's resolver does the normalisation (trailing slashes, empty
  // segments) and its own traversal wall; a second resolver would drift from
  // it. The NARROWER room is an added check, not a second resolver: roInRoom
  // hardcodes both open rooms, so athena/-only has to be decided here.
  const p = roResolve(rawPath);
  if (!p.ok || p.prefix !== "athena" || p.path === "athena") {
    return rwRes(`room_closed: ${p.prefix}\n`, 403, rawPath);
  }

  // Body cap. Content-Length first when present, so an oversized body is
  // refused before it is read; the decoder below still measures the real
  // bytes, so a lying or absent header cannot slip past.
  const declaredLength = Number(request.headers.get("Content-Length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > RW_MAX_BODY_BYTES) {
    return rwRes(`body_too_large: over ${RW_MAX_BODY_BYTES} bytes\n`, 413, p.path);
  }
  const rawBody = await request.arrayBuffer();
  if (rawBody.byteLength > RW_MAX_BODY_BYTES) {
    return rwRes(`body_too_large: over ${RW_MAX_BODY_BYTES} bytes\n`, 413, p.path);
  }
  // The body is UTF-8 text, and only UTF-8: a fatal decoder refuses mojibake
  // rather than silently writing replacement characters to the store.
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(rawBody);
  } catch {
    return rwRes("bad_utf8\n", 400, p.path);
  }

  // The lease-gated shapes have no second door (spec §5). NOW.md and the
  // INDEX refuse outright; creating a build-state-* file is a lease-gated
  // act and this door carries no lease parameter — appending to an existing
  // one is the same rule memory_append enforces.
  if (p.path === LEASE_NOW_PATH || p.path === LEASE_INDEX_PATH) {
    return rwRes("lease_gated: use the MCP memory_append verb with an estate lease\n", 403, p.path);
  }
  const existing = await readFile(env, p.path);
  if (existing === null && LEASE_FORK_RE.test(p.path)) {
    return rwRes("lease_gated: creating a build-state file requires the estate lease\n", 403, p.path);
  }

  // Frozen-part wall (dispatch 773): an append to an athena/build-state-*.md
  // part INDEX does not name live is refused, fail-closed on an INDEX that
  // cannot be read or names no single part. /rw/append carries no lease, so
  // there is no way out at this door -- the forking session uses the MCP
  // memory_append verb with the estate lease.
  if (isBuildPart(p.path)) {
    const fault = frozenPartFault(p.path, await readFile(env, LEASE_INDEX_PATH));
    if (fault) return rwRes(fault + "\n", 403, p.path);
  }

  try {
    // appendFile owns the combine, the encrypted R2 write and the keyword
    // index hook — the same function memory_append calls, so this door cannot
    // drift from the verb layer. `existing` is handed over because the lease
    // check above already had to read it.
    const combined = await appendFile(env, p.path, content, existing);

    // The vector half of the index, same as memory_append, so an appended
    // file stays semantically searchable. Non-fatal, and said so: an index
    // that fails is a staleness the nightly repairs, not a lost write.
    let indexNoteText = "";
    try {
      const r = await indexMemoryFile(env, p.path, combined);
      const n = indexNote(r);
      if (n) indexNoteText = `\nindex_partial: ${n}`;
    } catch (e) {
      console.error("Vector indexing failed (non-fatal):", e);
      indexNoteText = `\nindex_failed: ${String(e).slice(0, 160)}`;
    }

    const enc = new TextEncoder();
    const appendedBytes = enc.encode(content).length;
    const totalBytes = enc.encode(combined).length;
    return rwRes(
      `${existing === null ? "created" : "appended"}: ${p.path}\n` +
        `bytes_appended: ${appendedBytes}\n` +
        `new_total_bytes: ${totalBytes}${indexNoteText}\n`,
      200,
      p.path
    );
  } catch (e) {
    return rwRes(`${String(e)}\n`, 500, rawPath);
  }
}

// --------------------------------------------------------------------------
// Default handler — login page + non-API routes
// --------------------------------------------------------------------------

/** JSON body, no caching — the admin index routes speak JSON to the instrument. */
function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

const defaultHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check — unauthenticated, always available
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          server: "the-garden-mcp",
          version: "4.0.0",
          auth: "oauth2.1",
          extraction: "sonnet",
          tools: 45,
          oura_endpoints: 15,
          cronometer_exports: 5,
          withings_endpoints: 2,
          garmin_endpoints: 11,
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Read-only garden routes (dispatch 070) — keyed, GET-only, two rooms.
    // Handled here, before the MCP/login branch, so nothing below can warm
    // the ledger on their behalf.
    if (url.pathname.startsWith("/ro/")) {
      return handleReadOnly(request, env, url);
    }

    // The keyed append-only write door (19 Sep 2026) — POST-only, athena/
    // only, its own key. Same dispatch position as the read door: before the
    // MCP/login branch, and the handler never calls recordAccess.
    if (url.pathname === "/rw/append") {
      return handleRwAppend(request, env, url);
    }
    // Lease WRITE door (dispatch 147): keyed exactly as /rw/append.
    if (url.pathname === "/lease/acquire" || url.pathname === "/lease/release" || url.pathname === "/lease/renew") {
      return handleLeaseHttp(request, env, url, { leaseFetch, keyOk: roKeyOk });
    }
    // STATE write door (dispatch 242): keyed exactly as /rw/append; overwrites
    // athena/STATE.md and nothing else.
    if (url.pathname === "/rw/state") {
      return handleStateHttp(request, env, url, { keyOk: roKeyOk, writeFile });
    }

    // Verb-layer lease: box servers validate tokens here before a gated act
    // (spec §6). Unauthenticated on purpose: the token IS the credential,
    // and this surface is read-shaped — validate a token, read the holder,
    // read the refusal log. Acquire/renew/release exist only as MCP tools
    // behind OAuth.
    if (url.pathname === "/lease/validate") {
      const token = url.searchParams.get("token") ?? "";
      const act = url.searchParams.get("act") ?? "unnamed";
      const r = await leaseFetch(
        env.LEASE,
        `/validate?token=${encodeURIComponent(token)}&act=${encodeURIComponent(act)}`
      );
      return new Response(JSON.stringify(r.body), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/lease/status") {
      const r = await leaseFetch(env.LEASE, "/status");
      return new Response(JSON.stringify(r.body), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/lease/refusals") {
      const r = await leaseFetch(env.LEASE, "/refusals");
      return new Response(JSON.stringify(r.body), {
        headers: { "Content-Type": "application/json" },
      });
    }
    // Lease WRITES: MCP tools behind OAuth, plus the keyed HTTP door above
    // (dispatch 147, 24 Sep 2026) -- the real automation consumer the 30 Aug
    // removal named as the evidence that reopens it: the chain runner.

    // Backfill extractions — one-time endpoint, auth via password hash
    if (url.pathname === "/backfill") {
      return handleBackfill(request, env);
    }

    // Blocking nightly trigger for verification (25 Aug 2026). The laptop
    // pattern (wrangler dev --test-scheduled) is impossible on the hardened
    // forge (uv_interface_addresses blocked), so the production-compatible
    // form: POST with x-garden-key matching the GARDEN_ADMIN_KEY secret,
    // awaits the full nightly, returns when done. 404 without the secret set.
    if (
      url.pathname === "/run-nightly" ||
      url.pathname === "/run-dream" ||
      url.pathname === "/migrate-fitness" ||
      url.pathname === "/migrate-activation" ||
      url.pathname === "/activation-state"
    ) {
      const key = request.headers.get("x-garden-key");
      if (!env.GARDEN_ADMIN_KEY || key !== env.GARDEN_ADMIN_KEY) {
        return new Response("Not found", { status: 404 });
      }
      if (url.pathname === "/activation-state") {
        // Read-only verification view: decrypted ledger + spread, server-side.
        const [ledger, spread] = await Promise.all([
          readLedger(env),
          readSpread(env),
        ]);
        return new Response(JSON.stringify({ ledger, spread }, null, 1), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (request.method !== "POST") {
        return new Response("Not found", { status: 404 });
      }
      if (url.pathname === "/migrate-activation") {
        // One-shot (dispatch 074): meta/activation/{ledger,spread,neighbours}
        // .json -> the D1 `accesses` and `neighbours` tables. The R2 objects
        // are LEFT IN PLACE and never read again — they are the rollback.
        //
        // Idempotent by refusal: 409 if `accesses` already has rows. Pass
        // ?force=1 to wipe and reload, which is what you want if an MCP call
        // slipped in between the deploy and this request.
        const force = url.searchParams.get("force") === "1";
        const t0 = Date.now();
        try {
          const r = await migrateActivationToD1(env, force);
          if ("conflict" in r) {
            return new Response(
              JSON.stringify(
                {
                  error: "accesses already populated",
                  existing_rows: r.conflict,
                  hint: "re-run with ?force=1 to wipe and reload",
                  ms: Date.now() - t0,
                },
                null,
                1
              ) + "\n",
              { status: 409, headers: { "Content-Type": "application/json" } }
            );
          }
          return new Response(
            JSON.stringify({ ms: Date.now() - t0, ...r }, null, 1) + "\n",
            { headers: { "Content-Type": "application/json" } }
          );
        } catch (e) {
          return new Response(`${String(e)} after ${Date.now() - t0} ms\n`, {
            status: 500,
          });
        }
      }
      if (url.pathname === "/migrate-fitness") {
        // One-shot: relocate legacy fitness/*.md into memory/brother/workouts/
        // and index them. Idempotent — existing destinations are skipped, never
        // overwritten. Default is a DRY RUN; pass ?apply=true to commit.
        const dryRun = url.searchParams.get("apply") !== "true";
        const t0 = Date.now();
        try {
          const r = await migrateFitnessToMemory(env, dryRun);
          return new Response(
            JSON.stringify(
              { dryRun, ms: Date.now() - t0, ...r },
              null,
              1
            ) + "\n",
            { headers: { "Content-Type": "application/json" } }
          );
        } catch (e) {
          return new Response(`${String(e)} after ${Date.now() - t0} ms\n`, {
            status: 500,
          });
        }
      }
      if (url.pathname === "/run-dream") {
        // Blocking dream trigger (25 Aug 2026). Detached in-DO promises are
        // cancelled by the runtime (measured: morning dispatch left neither a
        // log line nor a staged dream -- the documented absence signal), and
        // a blocking MCP call outlives the chat connector. A forge-side curl
        // holds this invocation alive for as long as the dream takes. Fire it
        // with nohup and walk away: outcome lands in staging + this response.
        const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 14, 1), 92);
        const overwrite = url.searchParams.get("overwrite") === "true";
        const t0 = Date.now();
        try {
          const r = await runDream(env, days, overwrite);
          return new Response(
            `dream staged: ${r.path} (${r.sourceCount} extractions, ${r.window}) in ${Date.now() - t0} ms\n`
          );
        } catch (e) {
          return new Response(`${String(e)} after ${Date.now() - t0} ms\n`, { status: 500 });
        }
      }
      const t0 = Date.now();
      await runNightly(env, "manual-trigger");
      return new Response(`nightly done in ${Date.now() - t0} ms\n`);
    }

    // Backfill vector index — one-time endpoint, auth via password hash OR
    // x-garden-key (6 Sep 2026; handleVectorBackfill checks both).
    if (url.pathname === "/backfill-vectors") {
      return handleVectorBackfill(request, env);
    }

    // Recent reindex — the forge-driven form of the nightly vector pass.
    // x-garden-key only; 404 without the secret set (mirrors /run-nightly).
    if (url.pathname === "/reindex-recent") {
      const key = request.headers.get("x-garden-key");
      if (!env.GARDEN_ADMIN_KEY || key !== env.GARDEN_ADMIN_KEY) {
        return new Response("Not found", { status: 404 });
      }
      return handleReindexRecent(request, env);
    }

    // Keyword index rebuild — the paginated, resumable first fill.
    // x-garden-key only; 404 without the secret set (mirrors /reindex-recent).
    if (url.pathname === "/reindex-keywords") {
      const key = request.headers.get("x-garden-key");
      if (!env.GARDEN_ADMIN_KEY || key !== env.GARDEN_ADMIN_KEY) {
        return new Response("Not found", { status: 404 });
      }
      const room = (url.searchParams.get("room") || "").trim();
      if (!room) return jsonRes({ error: "room is required" }, 400);
      const cursor = url.searchParams.get("cursor") || undefined;
      const batch = Math.min(
        Math.max(parseInt(url.searchParams.get("batch") || "40", 10) || 40, 1),
        200
      );
      const t0 = Date.now();
      try {
        const page = await kwReindexPage(env, room, cursor, batch);
        return jsonRes({
          room: page.room,
          processed: page.processed,
          next_cursor: page.nextCursor,
          elapsed_ms: Date.now() - t0,
        });
      } catch (e) {
        return jsonRes({ room, error: String(e), elapsed_ms: Date.now() - t0 }, 500);
      }
    }

    // Keyword index status. `files` is the room's postings-receipt count and
    // `texts` its text-mirror count; both are meant to equal an independent
    // recursive /ro/list walk of .md files, and each other. files > texts is a
    // hole in the mirror; texts null means migration 0002 is not applied.
    if (url.pathname === "/kwindex-status") {
      const key = request.headers.get("x-garden-key");
      if (!env.GARDEN_ADMIN_KEY || key !== env.GARDEN_ADMIN_KEY) {
        return new Response("Not found", { status: 404 });
      }
      const room = (url.searchParams.get("room") || "").trim();
      if (!room) return jsonRes({ error: "room is required" }, 400);
      try {
        return jsonRes(await kwIndexStatus(env, room));
      } catch (e) {
        return jsonRes({ room, error: String(e) }, 500);
      }
    }

    // OAuth authorization page
    if (url.pathname === "/authorize") {
      const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);

      if (request.method === "GET") {
        return new Response(loginPageHtml(), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (request.method === "POST") {
        const formData = await request.formData();
        const password = formData.get("password") as string | null;

        if (!password) {
          return new Response(loginPageHtml("Password required"), {
            status: 400,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }

        const inputHash = await sha256hex(password);

        if (inputHash !== env.LOGIN_PASSWORD_HASH) {
          return new Response(loginPageHtml("Invalid password"), {
            status: 401,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }

        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: oauthReqInfo,
          userId: "brother-thunderbird",
          metadata: { label: "the-garden-owner" },
          scope: oauthReqInfo.scope || ["garden:full"],
          props: {
            userId: "brother-thunderbird",
            role: "owner",
          },
        });

        return Response.redirect(redirectTo, 302);
      }

      return new Response("Method not allowed", { status: 405 });
    }

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

// --------------------------------------------------------------------------
// API handler — authenticated MCP requests
// --------------------------------------------------------------------------

const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    return handleMcpRequest(request, env);
  },
};

// --------------------------------------------------------------------------
// Nightly consolidation — the scheduled handler
//
// 🔴 WHY THIS FILE NO LONGER EXPORTS THE PROVIDER DIRECTLY.
// OAuthProvider declares exactly one method: fetch(). It has no `scheduled`,
// so `export default new OAuthProvider(...)` gives the Worker no way to
// receive a cron event. The trigger in wrangler.jsonc had been firing daily
// into nothing. Verified 22 Aug 2026 by reading the package's own .d.ts, not
// inferred from behaviour.
//
// The fix is to export a plain handler object that delegates fetch to the
// provider and handles scheduled itself. OAuth behaviour is unchanged.
// --------------------------------------------------------------------------

const NIGHTLY_LOG = "shared/system/nightly-log.md";
const NIGHTLY_LOG_KEEP = 60; // ~two months of runs

/**
 * Rebuild the association graph and leave evidence that it happened.
 *
 * The log is not decoration. Twice in this project a system moved and nothing
 * told anyone — the gateway died on 25 July and was found on 8 August, by
 * accident. A cron that runs silently is indistinguishable from a cron that
 * does not run, and this one has been the second kind since it was added.
 *
 * Cost: one R2 get per extraction, plus a read and a write for the log. No
 * Anthropic call — the Sonnet extractions were already paid for at write time;
 * buildGraph only re-aggregates them.
 */
async function runNightly(env: Env, cron: string): Promise<void> {
  const started = Date.now();
  const stamp = new Date().toISOString();
  let line: string;

  // Self-healing sweep first, so recovered extractions flow into the same
  // night's graph rebuild. Capped: one night can never run an unbounded bill.
  // Added 22 Aug 2026 after a retired model left 68 days of writes
  // unextracted with nothing noticing.
  let sweepNote = "";
  try {
    const s = await sweepMissingExtractions(env, 25);
    const remaining = s.missing - s.extracted - s.failed;
    if (s.missing === 0) {
      sweepNote = " · sweep: nothing missing";
    } else {
      sweepNote = ` · sweep: ${s.extracted} extracted, ${s.failed} failed, ${remaining} still missing of ${s.checked} checked`;
      if (s.firstError) sweepNote += ` — first error: ${s.firstError.slice(0, 160)}`;
    }
  } catch (e) {
    sweepNote = ` · sweep FAILED: ${String(e).slice(0, 160)}`;
    console.error("Nightly sweep failed:", e);
  }

  try {
    const graph = await buildGraph(env);
    const ms = Date.now() - started;
    // entities/themes/emotions are Record<string, Node>, NOT arrays. `.length`
    // on a Record typechecks — an index signature makes every property name
    // legal — and evaluates to undefined. That bug shipped on 22 Aug and
    // reported "0 entities" for a rebuild that had indexed 104 entries.
    const entities = Object.keys(graph.entities ?? {}).length;
    const themes = Object.keys(graph.themes ?? {}).length;
    const emotions = Object.keys(graph.emotions ?? {}).length;
    line =
      `- ${stamp} · \`${cron}\` · ✅ graph rebuilt — ${graph.extractionCount} entries indexed, ` +
      `${entities} entities, ${themes} themes, ${emotions} emotions · ` +
      `range ${graph.dateRange.earliest}→${graph.dateRange.latest} · ${ms} ms`;
  } catch (e) {
    const ms = Date.now() - started;
    line = `- ${stamp} · \`${cron}\` · 🔴 graph rebuild FAILED after ${ms} ms — ${String(e)}`;
    console.error("Nightly graph rebuild failed:", e);
  }

  line = line + sweepNote;

  // Neighbours map for one-hop spreading activation. Machinery: reads
  // extractions directly, never touches the access ledger.
  try {
    const n = await rebuildNeighbours(env);
    line += ` · neighbours: ${n} paths`;
  } catch (e) {
    line += ` · neighbours FAILED: ${String(e).slice(0, 120)}`;
  }

  // The bound on `accesses` (074). capTimes() already makes every READ correct
  // at any table size; this is what keeps the table itself from growing
  // forever. Silent when there was nothing to drop, so the nightly line only
  // grows on the nights it did something.
  try {
    const pruned = await pruneAccesses(env);
    if (pruned > 0) line += ` · ledger pruned: ${pruned} rows`;
  } catch (e) {
    line += ` · ledger prune FAILED: ${String(e).slice(0, 120)}`;
  }

  await appendNightlyLine(env, line);

  // The health line -- the garden's vital signs, roadmap item 1. The
  // instrument that notices when something STOPS MOVING: the 68-day
  // extraction outage would have shown here in week one as a frozen
  // extracted-count and a stale last-write. Appended as its own line so a
  // health failure can never take the graph line down with it.
  try {
    await appendNightlyLine(env, await buildHealthLine(env));
  } catch (e) {
    await appendNightlyLine(
      env,
      `- ${new Date().toISOString()} · health FAILED: ${String(e).slice(0, 200)}`
    );
  }
}

/** Count R2 objects under a prefix, paginated. */
async function countPrefix(
  env: Env,
  prefix: string
): Promise<{ count: number; latestKey: string }> {
  let count = 0;
  let latestKey = "";
  let cursor: string | undefined;
  do {
    const res = await env.GARDEN_BUCKET.list({ prefix, cursor, limit: 1000 });
    for (const o of res.objects) {
      count++;
      if (o.key > latestKey) latestKey = o.key;
    }
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return { count, latestKey };
}

async function buildHealthLine(env: Env): Promise<string> {
  const stamp = new Date().toISOString();
  // Memory files live under the R2 prefix "memory/" (storage.ts
  // GARDEN_PREFIX); meta/ lives at bucket root. The first health line ever
  // written (24 Aug 19:08 UTC) reported files sphinx:0 because it forgot
  // this -- the instrument's first act was catching its own bug.
  const M = "memory/";
  const [sphinx, luma, shared, extractions] = await Promise.all([
    countPrefix(env, M + "sphinx/"),
    countPrefix(env, M + "luma/"),
    countPrefix(env, M + "shared/"),
    countPrefix(env, "meta/extractions/"),
  ]);

  // Written-vs-extracted coverage per extractable dir.
  const dirs = ["sphinx/journal/", "luma/journal/", "shared/threads/"];
  const coverage: string[] = [];
  for (const d of dirs) {
    const files = await countPrefix(env, M + d);
    const extracted = await countPrefix(env, "meta/extractions/" + d);
    const lastDate = files.latestKey.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? "?";
    coverage.push(
      `${d.replace(/\/$/, "")} ${extracted.count}/${files.count} last:${lastDate}`
    );
  }

  // Vector count against file count. Measured from the binding, not
  // remembered from docs; field name differs across API versions, so take
  // whichever exists and say '?' rather than guess.
  let vectors = "?";
  try {
    const info = (await env.VECTORIZE.describe()) as unknown as Record<string, unknown>;
    const v = info["vectorCount"] ?? info["vectorsCount"] ?? info["count"];
    if (typeof v === "number") vectors = String(v);
  } catch {
    vectors = "describe-failed";
  }

  const lv = await ledgerVitals(env);
  const memFiles = sphinx.count + luma.count + shared.count;

  return (
    `- ${stamp} · health · files sphinx:${sphinx.count} luma:${luma.count} shared:${shared.count} · ` +
    `extracted ${extractions.count}/${memFiles} (${coverage.join(", ")}) · ` +
    `vectors ${vectors} · ` +
    `ledger ${lv.paths} paths/${lv.hits} hits, spread ${lv.spreadPaths}/${lv.spreadHits}`
  );
}

/**
 * Append one line to the shared nightly log, newest first, bounded.
 * A log that grows without limit becomes a file nobody opens.
 */
async function appendNightlyLine(env: Env, line: string): Promise<void> {
  try {
    const existing = await readFile(env, NIGHTLY_LOG);
    const header = "# Nightly run log\n\n*Newest first. Written by the scheduled handler.*\n\n";
    const previous = existing
      ? existing
          .split("\n")
          .filter((l) => l.startsWith("- 20"))
          .slice(0, NIGHTLY_LOG_KEEP - 1)
      : [];
    await writeFile(env, NIGHTLY_LOG, header + [line, ...previous].join("\n") + "\n");
  } catch (e) {
    console.error("Nightly log write failed (non-fatal):", e);
  }
}

/**
 * Weekly dream cron -- Saturdays 17:00 UTC = Sunday 5am NZST, so a Sunday
 * morning arrival finds a fresh dream staged. Wired 23 Aug 2026 on Brother's
 * call ("otherwise this dream thing dies a neglected death") -- momentum over
 * the spec's earn-it-first law, dissent recorded in the 23 Aug journal.
 * Refusal semantics preserved: a manual dream already staged today makes the
 * cron log "skipped", never overwrite. Failures land in the same log.
 */
async function runWeeklyDream(env: Env, cron: string): Promise<void> {
  const stamp = new Date().toISOString();
  const started = Date.now();
  let line: string;
  try {
    const result = await runDream(env, 14, false);
    const ms = Date.now() - started;
    line = `- ${stamp} · \`${cron}\` · 🌙 weekly dream written to ${result.path} — ${result.sourceCount} extractions, ${result.window} · ${ms} ms`;
  } catch (e) {
    const msg = String(e);
    const ms = Date.now() - started;
    line = msg.includes("DREAM REFUSED")
      ? `- ${stamp} · \`${cron}\` · 🌙 weekly dream skipped — today's dream already staged · ${ms} ms`
      : `- ${stamp} · \`${cron}\` · 🔴 weekly dream FAILED after ${ms} ms — ${msg.slice(0, 200)}`;
    if (!msg.includes("DREAM REFUSED")) console.error("Weekly dream failed:", e);
  }
  await appendNightlyLine(env, line);
}

/**
 * Nightly vector reindex -- 15:30 UTC daily (row C, 6 Sep 2026). Files
 * updated within 26 h, newest first, under a 40-subrequest budget so the
 * invocation cannot trip the per-invocation cap that silently broke indexing
 * for files over ~50 chunks. What it does not reach is written to the log as
 * a number, not hidden; the forge-driven /reindex-recent loop is the driver
 * for a backlog, this cron is the safety net.
 */
const VECTOR_REINDEX_CRON = "30 15 * * *";

async function runVectorReindex(env: Env, cron: string): Promise<void> {
  const stamp = new Date().toISOString();
  const started = Date.now();
  let line: string;
  try {
    const s = await reindexRecent(env, 26, { budget: 40 });
    const ms = Date.now() - started;
    const stop = s.lines.find((l) => l.startsWith("STOP:")) ? " (budget stop; more next pass)" : "";
    line = `- ${stamp} · \`${cron}\` · 🧭 vector reindex: ${s.processed} of ${s.candidates} recent files, embedded ${s.embedded}, reused ${s.reused}, deferred ${s.skipped}, failed ${s.failed}${stop} · ${ms} ms`;
  } catch (e) {
    const ms = Date.now() - started;
    line = `- ${stamp} · \`${cron}\` · 🔴 vector reindex FAILED after ${ms} ms — ${String(e).slice(0, 200)}`;
    console.error("Vector reindex failed:", e);
  }
  await appendNightlyLine(env, line);
}

/**
 * Nightly keyword-index reconciliation -- rides the 15:30 UTC vector cron.
 *
 * Reconciliation, not a rebuild from the top: it lists each room, compares it
 * against `files` AND against the `texts` mirror, reindexes what is stale,
 * unindexed or unmirrored up to a budget, and drops rows for files that no
 * longer exist. A nightly that always reindexed objects 1-N of a room would
 * redo the same N files every night and never reach N+1.
 *
 * SINCE 075 THIS IS THE WHOLE STALENESS GUARD. Searches used to carry it and
 * paid an R2 list each; now they read only D1 and this runs once a night. The
 * `+Nm` in the log line is mirror gaps — files whose postings were current but
 * whose text was missing — and it should be zero every night after the first
 * fill. It staying nonzero means files are being written past the verb layer.
 *
 * Bounded per room and per night, and it never fails the nightly: a room that
 * throws is named in the log line and the sweep continues. The budget stays at
 * 25 rather than rising to cover the work the searches used to do: six rooms x
 * 25 files x a get plus several D1 batches each already sits inside the 1000
 * queries-per-invocation limit with room to spare, and a backlog bigger than
 * that is a /reindex-keywords job, not a nightly one.
 */
const KW_RECONCILE_BUDGET_PER_ROOM = 25;

async function runKeywordReconcile(env: Env, cron: string): Promise<void> {
  const stamp = new Date().toISOString();
  const started = Date.now();
  let line: string;
  try {
    const rooms = await listRooms(env);
    const parts: string[] = [];
    let reindexed = 0;
    let removed = 0;
    let stale = 0;
    let gaps = 0;
    for (const room of rooms) {
      try {
        const s = await kwReconcileRoom(env, room, KW_RECONCILE_BUDGET_PER_ROOM);
        reindexed += s.reindexed;
        removed += s.removed;
        stale += s.stale;
        gaps += s.mirrorGaps;
        const behind = s.stale > s.reindexed ? `+${s.stale - s.reindexed} left` : "";
        const mirror = s.mirrorGaps ? ` +${s.mirrorGaps}m` : "";
        parts.push(`${room} ${s.files}f/${s.reindexed}r${mirror}${behind ? " " + behind : ""}`);
      } catch (e) {
        parts.push(`${room} FAILED`);
        console.error("Keyword reconcile failed for room:", room, e);
      }
    }
    const ms = Date.now() - started;
    line = `- ${stamp} · \`${cron}\` · 🔤 keyword index: ${reindexed} reindexed, ${removed} stale rows dropped, ${stale} were behind (${gaps} text-mirror gaps) — ${parts.join(", ")} · ${ms} ms`;
  } catch (e) {
    const ms = Date.now() - started;
    line = `- ${stamp} · \`${cron}\` · 🔴 keyword reconcile FAILED after ${ms} ms — ${String(e).slice(0, 200)}`;
    console.error("Keyword reconcile failed:", e);
  }
  await appendNightlyLine(env, line);
}

// --------------------------------------------------------------------------
// Worker export — OAuthProvider handles fetch, we handle scheduled
// --------------------------------------------------------------------------

const oauthProvider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: mcpApiHandler,
  defaultHandler: defaultHandler,

  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",

  // Token lifetimes
  accessTokenTTL: 2592000,   // 30 days
  refreshTokenTTL: 7776000,  // 90 days
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return oauthProvider.fetch(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // AWAIT, not waitUntil: the invocation stays alive until the nightly
    // finishes. waitUntil gave background work only a short grace after
    // invocation end -- five test triggers on 23 Aug 2026 were cancelled
    // mid-sweep with zero effect ("waitUntil() tasks did not complete
    // within the allowed time"). Awaiting is also the correct semantics
    // for cron: there is no response to hurry back for.
    // Dispatch on the cron expression: nightly maintenance vs weekly dream.
    if (controller.cron === "0 17 * * 6") {
      await runWeeklyDream(env, controller.cron);
    } else if (controller.cron === VECTOR_REINDEX_CRON) {
      await runVectorReindex(env, controller.cron);
      // Beside the vector pass, not inside it: the keyword reconciliation has
      // its own budget and its own log line, and neither can fail the other.
      await runKeywordReconcile(env, controller.cron);
    } else {
      await runNightly(env, controller.cron);
    }
  },
};
