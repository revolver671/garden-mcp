/**
 * The Garden -- Dream Layer (consolidation pass)
 *
 * A manually-triggered verb, not a cron. Runs ONE consolidation pass over the
 * association graph plus the stored extractions for a recent window, and
 * writes the result to shared/staging/. Never touches now.md; promotion is a
 * reviewed act. Design law in sphinx/notes/garden-dream-spec.md (in the
 * garden): the cron wiring happens only after a dream has once told us
 * something true we hadn't noticed.
 *
 * Consolidation is not summarising. The pass looks ACROSS episodes for
 * recurrences, contradictions, dropped debts, and resurfacing questions.
 */

import type { Env } from "./types";
import { readGraph, formatGraphSummary } from "./graph";
import { listExtractions, readExtraction, type Extraction } from "./extraction";

// Dream model (the judge). Split from EXTRACTION_MODEL on 25 Aug 2026:
// one consolidation call a week, quality over cost -- Opus-class at ~$0.35/wk
// estimated. Alias-style name, never a dated snapshot.
export const DREAM_MODEL = "claude-opus-5";
import { readFile, writeFile } from "./storage";
import {
  computeActivations,
  temperatureLabel,
  coldDebts,
} from "./activation";

// --------------------------------------------------------------------------
// Prompt (spec first draft -- expect to iterate against real output)
// --------------------------------------------------------------------------

const DREAM_PROMPT = `You are running a memory consolidation pass over one person's journal extractions and association graph. Do not summarise. Find only:

1. Patterns that recur across 3 or more separate entries.
2. Contradictions between what was recorded as intended and what later entries show happened.
3. Commitments or debts that stopped being mentioned without being resolved.
4. Questions that keep reappearing unanswered.
5. Cold debts: commitments or open questions whose source entries show near-zero retrieval for 30+ days -- the things we stopped looking at. Use the per-entry Activation headers and the Cold paths appendix; they are measured retrieval data, not inference.

Cite entry dates for every claim. If a category has nothing, say "nothing found" for it -- an empty finding is a valid finding and a fabricated pattern is the worst possible output. Plain words. No metaphors.

The association graph below covers all time; the extractions cover only the recent window. A pattern needs support in the extractions themselves -- the graph is context, not evidence.

`;

// --------------------------------------------------------------------------
// Result type
// --------------------------------------------------------------------------

export interface DreamResult {
  path: string;
  text: string;
  sourceCount: number;
  window: string;
}

function nzDateStamp(d: Date): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Pacific/Auckland",
  }).format(d);
}

function formatExtraction(ex: Extraction): string {
  const lines: string[] = [`### ${ex.sourcePath}`];
  if (ex.summary) lines.push(`Summary: ${ex.summary}`);
  if (ex.decisions?.length) lines.push(`Decisions: ${ex.decisions.join(" | ")}`);
  if (ex.openQuestions?.length)
    lines.push(`Open questions: ${ex.openQuestions.join(" | ")}`);
  if (ex.themes?.length) lines.push(`Themes: ${ex.themes.join(", ")}`);
  if (ex.emotions?.length) lines.push(`Emotions: ${ex.emotions.join(", ")}`);
  if (ex.entities?.length)
    lines.push(`Entities: ${ex.entities.map((e) => e.name).join(", ")}`);
  return lines.join("\n");
}

// --------------------------------------------------------------------------
// The pass
// --------------------------------------------------------------------------

export async function runDream(
  env: Env,
  days: number,
  overwrite: boolean
): Promise<DreamResult> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not set -- cannot dream.");
  }
  if (!Number.isFinite(days) || days < 1 || days > 92) {
    throw new Error(`days must be between 1 and 92, got ${days}`);
  }

  const now = new Date();
  const todayNz = nzDateStamp(now);
  const stagingPath = `shared/staging/dream-${todayNz}.md`;

  // Idempotence guard and daily budget cap in one mechanism. Checked before
  // any expensive work.
  const existing = await readFile(env, stagingPath);
  if (existing !== null && !overwrite) {
    throw new Error(
      `DREAM REFUSED: ${stagingPath} already exists. One dream per day; pass overwrite=true to replace it.`
    );
  }

  const cutoffNz = nzDateStamp(new Date(now.getTime() - days * 86400000));

  const graph = await readGraph(env);
  if (!graph) {
    throw new Error(
      "DREAM FAILED: no association graph -- run garden_graph_rebuild first."
    );
  }

  // Gather extractions in the window. Dated filenames (journals) filter by
  // string compare on YYYY-MM-DD without a read; undated files (threads) are
  // read and filtered on extractedAt. Read volume is bounded by measured
  // behaviour: the nightly rebuild reads every extraction in one invocation.
  const jsonPaths = await listExtractions(env);
  const picked: Extraction[] = [];
  for (const jsonPath of jsonPaths) {
    const sourcePath = jsonPath.replace(/\.json$/i, ".md");
    const m = jsonPath.match(/(\d{4}-\d{2}-\d{2})/);
    if (m && m[1] < cutoffNz) continue; // dated and too old: skip without reading
    const ex = await readExtraction(env, sourcePath);
    if (!ex) continue;
    if (!m && (!ex.extractedAt || ex.extractedAt.slice(0, 10) < cutoffNz)) {
      continue;
    }
    picked.push(ex);
  }

  if (picked.length === 0) {
    throw new Error(
      `DREAM FAILED: no extractions found in the last ${days} days.`
    );
  }

  picked.sort((a, b) =>
    a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0
  );

  // Temperature (activation layer, 25 Aug 2026): each entry carries its
  // measured retrieval warmth; percentile within this window. The cold-paths
  // appendix is the all-time neglect ledger. Both computed by machinery
  // reading derived files -- no accesses are recorded by dreaming.
  const acts = await computeActivations(
    env,
    picked.map((p) => p.sourcePath)
  );
  const finiteActs = Object.values(acts).filter((a) => isFinite(a));
  const header = (p: string): string => {
    const a = acts[p];
    const label = temperatureLabel(a, finiteActs);
    return `Activation: ${label} (A=${isFinite(a) ? a.toFixed(2) : "never-accessed"})`;
  };

  const debts = await coldDebts(env, 10);
  const debtLines = debts.length
    ? debts.map(
        (d) =>
          `- ${d.path} · ${d.daysSinceAccess === null ? "never accessed" : `${d.daysSinceAccess}d since access`} · open: ${d.openQuestions.join(" | ")}`
      )
    : ["(none -- every open question's source has been walked within 30 days)"];

  const corpus = [
    "## Association graph (all time -- context, not evidence)",
    "",
    formatGraphSummary(graph),
    "",
    `## Extractions, ${cutoffNz} to ${todayNz} (${picked.length} entries -- the evidence)`,
    "",
    picked
      .map((ex) => header(ex.sourcePath) + "\n" + formatExtraction(ex))
      .join("\n\n"),
    "",
    "## Cold paths (all time: open questions, 30+ days without retrieval -- the neglect ledger)",
    "",
    debtLines.join("\n"),
  ].join("\n");

  // One Anthropic call, STREAMED (25 Aug 2026). The first Opus 5 dream at
  // max_tokens 16000 died with a 524 at Anthropic's edge: adaptive thinking
  // over a large corpus generates for longer than a non-streaming request is
  // allowed to live. SSE keeps the connection alive for the duration; we
  // accumulate text deltas and keep the fails-whole contract.
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: DREAM_MODEL,
      // 25 Aug 2026, twice-raised: 4000 -> 16000 -> 64000. Opus 5 adaptive
      // thinking shares this budget with the text; at 16000 it thought for
      // the ENTIRE budget over the full corpus and never wrote a word
      // (measured: blocks=thinking, stop_reason=max_tokens, 278s). Thinking
      // cannot be configured off; the roof must hold both. ~$1/dream worst
      // case at Opus 5 output pricing -- the judge is allowed to think.
      max_tokens: 64000,
      stream: true,
      messages: [{ role: "user", content: DREAM_PROMPT + corpus }],
    }),
  });

  if (!response.ok) {
    throw new Error(
      `DREAM FAILED: Anthropic API ${response.status} ${response.statusText}`
    );
  }
  if (!response.body) {
    throw new Error("DREAM FAILED: no response body from streaming API.");
  }

  // Parse the SSE stream: accumulate text_delta chunks, track block types
  // and stop_reason so a textless dream still fails with a diagnosis.
  let dreamAccum = "";
  let stopReason = "?";
  const blockTypes = new Set<string>();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const raw of lines) {
      if (!raw.startsWith("data:")) continue;
      const payload = raw.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const ev = JSON.parse(payload) as {
          type: string;
          content_block?: { type: string };
          delta?: { type?: string; text?: string; stop_reason?: string };
        };
        if (ev.type === "content_block_start" && ev.content_block) {
          blockTypes.add(ev.content_block.type);
        } else if (
          ev.type === "content_block_delta" &&
          ev.delta?.type === "text_delta" &&
          ev.delta.text
        ) {
          dreamAccum += ev.delta.text;
        } else if (ev.type === "message_delta" && ev.delta?.stop_reason) {
          stopReason = ev.delta.stop_reason;
        } else if (ev.type === "error") {
          throw new Error(`DREAM FAILED: stream error event: ${payload.slice(0, 200)}`);
        }
      } catch (e) {
        if (String(e).startsWith("Error: DREAM FAILED")) throw e;
        // Malformed SSE line: skip; the fails-whole check below still guards.
      }
    }
  }

  if (!dreamAccum.trim()) {
    throw new Error(
      `DREAM FAILED: no text in streamed response (blocks: ${[...blockTypes].join(",") || "none"}; stop_reason: ${stopReason}).`
    );
  }
  const dreamText = dreamAccum.trim();

  const fileContent = [
    `# Dream -- ${todayNz}`,
    ``,
    `*Consolidation pass over ${picked.length} extractions (${cutoffNz} to ${todayNz}, ${days}-day window), generated ${now.toISOString()}. STAGING ONLY -- promotion into now.md is a reviewed act, never automatic.*`,
    ``,
    `---`,
    ``,
    dreamText,
    ``,
  ].join("\n");

  // Written via the storage layer directly. shared/staging/ is deliberately
  // outside the extraction trigger paths (/journal/, /threads/) and outside
  // the vector index: an unpromoted dream must not feed the corpus it dreams
  // over, and must not surface in semantic search as if it were a memory.
  await writeFile(env, stagingPath, fileContent);

  return {
    path: stagingPath,
    text: fileContent,
    sourceCount: picked.length,
    window: `${cutoffNz} to ${todayNz}`,
  };
}
