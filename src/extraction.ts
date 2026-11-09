/**
 * The Garden — Extraction Layer (Phase 3, Layer 1)
 * Calls Anthropic API (Sonnet) to extract structured metadata
 * from journal entries and threads.
 *
 * Extracts: entities, emotions, themes, decisions, open questions,
 * and cross-references between them.
 *
 * Stored as shadow JSON files in R2 under meta/extractions/
 */

import type { Env } from "./types";
import { encrypt, decrypt } from "./crypto";

// Extraction model (the labourer). HISTORY: this was
// "claude-sonnet-4-20250514" until 22 Aug 2026, when we discovered the API
// had been returning 404 (model retired) since ~15 June -- and the silent
// failure path below buried it for 68 days. If extraction dies again, the
// write tools now say so loudly. Prefer alias-style model names that track
// the current snapshot. Upgraded to Sonnet 5 on 25 Aug 2026, deployed from
// the forge (first cloud-built change). Sonnet 5 rejects non-default
// temperature/top_p/top_k and manual thinking config -- we set none.
export const EXTRACTION_MODEL = "claude-sonnet-5";

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export interface Extraction {
  /** ISO timestamp of extraction */
  extractedAt: string;
  /** Source file path (e.g. sphinx/journal/2026-04-05.md) */
  sourcePath: string;
  /** Entities: people, projects, places, concepts */
  entities: EntityRef[];
  /** Emotional tones present in the entry */
  emotions: string[];
  /** High-level themes */
  themes: string[];
  /** Decisions made or confirmed */
  decisions: string[];
  /** Open questions or unresolved threads */
  openQuestions: string[];
  /** Connections between entities/themes */
  connections: Connection[];
  /** One-sentence summary */
  summary: string;
}

export interface EntityRef {
  name: string;
  type: "person" | "project" | "place" | "concept" | "event" | "body" | "other";
}

export interface Connection {
  from: string;
  to: string;
  relationship: string;
}

// --------------------------------------------------------------------------
// Extraction prompt
// --------------------------------------------------------------------------

const EXTRACTION_PROMPT = `You are an extraction engine for a personal journal system. Extract structured metadata from the journal entry below.

Return ONLY valid JSON with this exact schema (no markdown, no backticks, no preamble):

{
  "entities": [
    {"name": "string", "type": "person|project|place|concept|event|body|other"}
  ],
  "emotions": ["string"],
  "themes": ["string"],
  "decisions": ["string"],
  "openQuestions": ["string"],
  "connections": [
    {"from": "entity/theme name", "to": "entity/theme name", "relationship": "short description"}
  ],
  "summary": "One sentence capturing the essence of this entry"
}

Guidelines:
- entities: Extract people (by name), projects (Athena, Kilimanjaro, the Garden, etc.), places, concepts (Option B, calibration pattern, etc.), events, and body-related items (sleep, training, CNS)
- emotions: The emotional tones PRESENT in the writing, not assumed. Use specific words.
- themes: High-level recurring themes (e.g. "sovereignty", "infrastructure", "relationship-navigation", "physical-training")
- decisions: Concrete decisions made or confirmed in this entry
- openQuestions: Things left unresolved, flagged for future
- connections: Meaningful relationships between entities/themes. Focus on non-obvious ones.
- summary: One sentence, capturing what this entry IS about at its core
- Be precise. Don't invent. Extract only what's there.
- Keep entity names consistent across extractions (e.g. always "Jenna" not "J" or "her")

Journal entry:
`;

// --------------------------------------------------------------------------
// Should we extract this file?
// --------------------------------------------------------------------------

export function shouldExtract(path: string): boolean {
  // Only extract journals and threads — these are the rich narrative content
  const lower = path.toLowerCase();
  if (lower.includes("/journal/") || lower.includes("/threads/")) {
    return lower.endsWith(".md");
  }
  return false;
}

// --------------------------------------------------------------------------
// Call Anthropic API for extraction
// --------------------------------------------------------------------------

async function callSonnet(
  content: string,
  apiKey: string
): Promise<{ extraction: Extraction | null; error?: string }> {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: EXTRACTION_MODEL,
        max_tokens: 4000, // raised from 2000 on 23 Aug 2026: dense journals truncated the JSON mid-string
        messages: [
          {
            role: "user",
            content: EXTRACTION_PROMPT + content,
          },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const error = `Anthropic API ${response.status} ${response.statusText} (model ${EXTRACTION_MODEL}): ${body.slice(0, 300)}`;
      console.error(`Extraction failed: ${error}`);
      return { extraction: null, error };
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text?: string }>;
    };

    const textBlock = data.content?.find((b) => b.type === "text");
    if (!textBlock?.text) {
      return { extraction: null, error: "no text block in API response" };
    }

    // Parse JSON — strip any accidental markdown fencing
    const clean = textBlock.text
      .replace(/^```json\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    const parsed = JSON.parse(clean);
    return { extraction: parsed as Extraction };
  } catch (e) {
    console.error(`Extraction failed: ${String(e)}`);
    return { extraction: null, error: String(e) };
  }
}

// --------------------------------------------------------------------------
// Store extraction in R2
// --------------------------------------------------------------------------

const META_PREFIX = "meta/extractions/";

function extractionKey(sourcePath: string): string {
  // sphinx/journal/2026-04-05.md → meta/extractions/sphinx/journal/2026-04-05.json
  const jsonPath = sourcePath.replace(/\.md$/i, ".json");
  return META_PREFIX + jsonPath;
}

async function storeExtraction(
  env: Env,
  sourcePath: string,
  extraction: Extraction
): Promise<void> {
  const key = extractionKey(sourcePath);
  const json = JSON.stringify(extraction, null, 2);
  const encrypted = await encrypt(json, env.ENCRYPTION_KEY);
  await env.GARDEN_BUCKET.put(key, encrypted, {
    customMetadata: {
      updatedAt: new Date().toISOString(),
      sourcePath: sourcePath,
    },
  });
}

export async function readExtraction(
  env: Env,
  sourcePath: string
): Promise<Extraction | null> {
  const key = extractionKey(sourcePath);
  const obj = await env.GARDEN_BUCKET.get(key);
  if (!obj) return null;
  try {
    const json = await decrypt(await obj.arrayBuffer(), env.ENCRYPTION_KEY);
    return JSON.parse(json) as Extraction;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// List all extractions (for graph building later)
// --------------------------------------------------------------------------

export async function listExtractions(
  env: Env,
  scope?: string
): Promise<string[]> {
  const prefix = META_PREFIX + (scope ? scope + "/" : "");
  const listed = await env.GARDEN_BUCKET.list({ prefix });
  return listed.objects
    .filter((obj) => obj.key.endsWith(".json"))
    .map((obj) => obj.key.replace(META_PREFIX, ""));
}

// --------------------------------------------------------------------------
// Main extraction entry point — called after memory_write/memory_append
// --------------------------------------------------------------------------

export async function extractIfEligible(
  env: Env,
  path: string,
  content: string
): Promise<{ extracted: boolean; summary?: string; error?: string }> {
  if (!shouldExtract(path)) {
    return { extracted: false };
  }

  // Skip very short content (< 200 chars) — not enough to extract from
  if (content.length < 200) {
    return { extracted: false };
  }

  // Need API key
  if (!env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set — skipping extraction");
    return { extracted: false, error: "ANTHROPIC_API_KEY not set" };
  }

  const result = await callSonnet(content, env.ANTHROPIC_API_KEY);
  if (!result.extraction) {
    // Eligible content that failed to extract is a real failure -- name it,
    // so the write path can say so instead of staying silent for 68 days.
    return { extracted: false, error: result.error ?? "extraction returned nothing" };
  }

  // Add metadata
  const extraction: Extraction = {
    ...result.extraction,
    extractedAt: new Date().toISOString(),
    sourcePath: path,
  };

  await storeExtraction(env, path, extraction);

  return {
    extracted: true,
    summary: extraction.summary,
  };
}
