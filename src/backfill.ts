/**
 * The Garden — Backfill Extraction
 * One-time endpoint to extract metadata from all existing
 * journals and threads. Runs server-side in the Worker.
 *
 * GET /backfill?token=LOGIN_PASSWORD_HASH
 * (Protected by password hash as a simple guard)
 */

import type { Env } from "./types";
import { decrypt } from "./crypto";
import { extractIfEligible, readExtraction } from "./extraction";

const MEMORY_PREFIX = "memory/";
const EXTRACT_PREFIXES = [
  "sphinx/journal/",
  "luma/journal/",
  "shared/journal/",
  "sphinx/threads/",
  "luma/threads/",
  "shared/threads/",
];

// --------------------------------------------------------------------------
// Missing-extraction sweep -- the self-healing net.
// Added 22 Aug 2026 after the model-retirement outage left a 68-day gap of
// unextracted entries with nothing noticing. Called by runNightly with a cap
// so one night can never run up an unbounded bill; idempotent, so repeated
// runs chew through a backlog and then settle to near-zero API calls.
// "missing" counts every .md without an extraction, including short files
// that are permanently ineligible -- those never consume an API call and
// form a stable floor in the "still missing" number.
// --------------------------------------------------------------------------

export interface SweepResult {
  checked: number;
  missing: number;
  extracted: number;
  failed: number;
  firstError?: string;
}

export async function sweepMissingExtractions(
  env: Env,
  cap: number
): Promise<SweepResult> {
  let checked = 0;
  let missing = 0;
  let extracted = 0;
  let failed = 0;
  let firstError: string | undefined;

  for (const prefix of EXTRACT_PREFIXES) {
    const r2Prefix = MEMORY_PREFIX + prefix;
    let cursor: string | undefined;
    do {
      const listed = await env.GARDEN_BUCKET.list({ prefix: r2Prefix, cursor });
      for (const obj of listed.objects) {
        if (!obj.key.endsWith(".md")) continue;
        checked++;
        const relPath = obj.key.replace(MEMORY_PREFIX, "");
        const already = await readExtraction(env, relPath);
        if (already) continue;
        missing++;
        if (extracted + failed >= cap) continue; // count the backlog, don't spend on it
        try {
          const r2obj = await env.GARDEN_BUCKET.get(obj.key);
          if (!r2obj) continue;
          const content = await decrypt(
            await r2obj.arrayBuffer(),
            env.ENCRYPTION_KEY
          );
          const result = await extractIfEligible(env, relPath, content);
          if (result.extracted) {
            extracted++;
          } else if (result.error) {
            failed++;
            firstError = firstError ?? `${relPath}: ${result.error}`;
          }
          // No error and not extracted = ineligible (too short). Not a failure.
        } catch (e) {
          failed++;
          firstError = firstError ?? `${relPath}: ${String(e)}`;
        }
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }

  return { checked, missing, extracted, failed, firstError };
}

export async function handleBackfill(
  request: Request,
  env: Env
): Promise<Response> {
  // Simple auth: require password hash as query param
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (token !== env.LOGIN_PASSWORD_HASH) {
    return new Response("Unauthorized", { status: 401 });
  }

  // ?missing=1 -- only extract files that have NO stored extraction yet.
  // Added 22 Aug 2026 to recover the 68-day gap after the model-retirement
  // outage without re-extracting ~104 files that are fine.
  const missingOnly = url.searchParams.get("missing") === "1";

  const results: string[] = [];
  let extracted = 0;
  let skipped = 0;
  let failed = 0;

  for (const prefix of EXTRACT_PREFIXES) {
    const r2Prefix = MEMORY_PREFIX + prefix;

    // List all .md files under this prefix
    let cursor: string | undefined;
    const keys: string[] = [];

    do {
      const listed = await env.GARDEN_BUCKET.list({ prefix: r2Prefix, cursor });
      for (const obj of listed.objects) {
        if (obj.key.endsWith(".md")) {
          keys.push(obj.key);
        }
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    for (const key of keys) {
      const relPath = key.replace(MEMORY_PREFIX, "");

      // Missing-only mode: skip anything that already has an extraction.
      if (missingOnly) {
        const already = await readExtraction(env, relPath);
        if (already) {
          skipped++;
          continue;
        }
      }

      // Read and decrypt the file
      try {
        const obj = await env.GARDEN_BUCKET.get(key);
        if (!obj) {
          results.push(`SKIP: ${relPath} (not found)`);
          skipped++;
          continue;
        }

        const content = await decrypt(await obj.arrayBuffer(), env.ENCRYPTION_KEY);

        if (content.length < 200) {
          results.push(`SKIP: ${relPath} (${content.length} chars — too short)`);
          skipped++;
          continue;
        }

        // Run extraction
        const result = await extractIfEligible(env, relPath, content);

        if (result.extracted) {
          results.push(`✅ ${relPath}: ${result.summary}`);
          extracted++;
        } else {
          results.push(`SKIP: ${relPath} (${result.error ?? "not eligible"})`);
          skipped++;
        }
      } catch (e) {
        results.push(`FAIL: ${relPath} (${String(e)})`);
        failed++;
      }
    }
  }

  const summary = `\n=== Backfill Complete ===\nExtracted: ${extracted} | Skipped: ${skipped} | Failed: ${failed}\n`;
  results.push(summary);

  return new Response(results.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
