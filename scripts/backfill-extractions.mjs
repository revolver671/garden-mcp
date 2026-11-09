/**
 * Backfill Extraction Script
 * Reads all journal and thread files from R2, calls Sonnet extraction,
 * stores results as encrypted shadow files.
 *
 * Usage: node scripts/backfill-extractions.mjs
 *
 * Requires env vars (or .dev.vars):
 *   ANTHROPIC_API_KEY - Anthropic API key
 *
 * Reads wrangler config for R2 bucket and encryption key.
 * Must be run from the cloud_worker directory.
 */

import { execSync } from "child_process";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BUCKET = "the-garden";
const EXTRACTION_PREFIX = "meta/extractions/";
const MEMORY_PREFIX = "memory/";

// Paths to extract (journals + threads)
const EXTRACT_PATHS = [
  "sphinx/journal/",
  "luma/journal/",
  "shared/journal/",
  "sphinx/threads/",
  "luma/threads/",
  "shared/threads/",
];

// Get API key from env or wrangler secret
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("Set ANTHROPIC_API_KEY environment variable");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Extraction prompt (same as extraction.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listR2(prefix) {
  try {
    const output = execSync(
      `npx wrangler r2 object list ${BUCKET} --prefix "${prefix}" --remote`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    // Parse the JSON output
    const objects = JSON.parse(output);
    return objects
      .filter((obj) => obj.key.endsWith(".md"))
      .map((obj) => obj.key);
  } catch (e) {
    console.error(`Failed to list ${prefix}:`, e.message);
    return [];
  }
}

async function getR2(key) {
  try {
    const output = execSync(
      `npx wrangler r2 object get ${BUCKET}/${key} --remote --pipe`,
      { encoding: "buffer", stdio: ["pipe", "pipe", "pipe"] }
    );
    return output;
  } catch (e) {
    console.error(`Failed to get ${key}:`, e.message);
    return null;
  }
}

async function putR2(key, data) {
  try {
    execSync(
      `npx wrangler r2 object put ${BUCKET}/${key} --remote --pipe`,
      { input: data, stdio: ["pipe", "pipe", "pipe"] }
    );
    return true;
  } catch (e) {
    console.error(`Failed to put ${key}:`, e.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Crypto (matching crypto.ts - AES-256-GCM)
// ---------------------------------------------------------------------------

import { webcrypto } from "crypto";
const { subtle } = webcrypto;

let _cachedKey = null;

async function getKey(base64Key) {
  if (_cachedKey) return _cachedKey;
  const raw = Buffer.from(base64Key, "base64");
  _cachedKey = await subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  return _cachedKey;
}

async function decrypt(data, base64Key) {
  const key = await getKey(base64Key);
  const bytes = new Uint8Array(data);
  const iv = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12);
  const decrypted = await subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );
  return new TextDecoder().decode(decrypted);
}

async function encrypt(plaintext, base64Key) {
  const key = await getKey(base64Key);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded
  );
  const result = new Uint8Array(iv.length + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), iv.length);
  return Buffer.from(result);
}

// ---------------------------------------------------------------------------
// Sonnet API call
// ---------------------------------------------------------------------------

async function callSonnet(content) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      messages: [
        { role: "user", content: EXTRACTION_PROMPT + content },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Sonnet API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const textBlock = data.content?.find((b) => b.type === "text");
  if (!textBlock?.text) throw new Error("No text in Sonnet response");

  const clean = textBlock.text
    .replace(/^```json\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  return JSON.parse(clean);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Get encryption key from wrangler secrets
  // You'll need to provide this as an env var
  const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
  if (!ENCRYPTION_KEY) {
    console.error("Set ENCRYPTION_KEY environment variable (base64 AES-256 key)");
    process.exit(1);
  }

  console.log("=== The Garden — Extraction Backfill ===\n");

  let total = 0;
  let extracted = 0;
  let skipped = 0;
  let failed = 0;

  for (const pathPrefix of EXTRACT_PATHS) {
    const r2Prefix = MEMORY_PREFIX + pathPrefix;
    console.log(`\nScanning: ${pathPrefix}`);

    const keys = listR2(r2Prefix);
    console.log(`  Found ${keys.length} files`);

    for (const key of keys) {
      total++;
      const relPath = key.replace(MEMORY_PREFIX, "");
      const extractionKey = EXTRACTION_PREFIX + relPath.replace(/\.md$/i, ".json");

      // Check if extraction already exists
      try {
        const existing = await getR2(extractionKey);
        if (existing) {
          console.log(`  SKIP: ${relPath} (already extracted)`);
          skipped++;
          continue;
        }
      } catch {
        // Doesn't exist — proceed
      }

      // Read and decrypt the file
      const encryptedData = await getR2(key);
      if (!encryptedData) {
        console.log(`  FAIL: ${relPath} (could not read)`);
        failed++;
        continue;
      }

      let content;
      try {
        content = await decrypt(encryptedData, ENCRYPTION_KEY);
      } catch (e) {
        console.log(`  FAIL: ${relPath} (decrypt failed: ${e.message})`);
        failed++;
        continue;
      }

      if (content.length < 200) {
        console.log(`  SKIP: ${relPath} (too short: ${content.length} chars)`);
        skipped++;
        continue;
      }

      // Call Sonnet for extraction
      try {
        console.log(`  EXTRACTING: ${relPath}...`);
        const result = await callSonnet(content);

        const extraction = {
          ...result,
          extractedAt: new Date().toISOString(),
          sourcePath: relPath,
        };

        // Encrypt and store
        const json = JSON.stringify(extraction, null, 2);
        const encryptedExtraction = await encrypt(json, ENCRYPTION_KEY);
        const success = await putR2(extractionKey, encryptedExtraction);

        if (success) {
          console.log(`  ✅ ${relPath}: ${extraction.summary}`);
          extracted++;
        } else {
          console.log(`  FAIL: ${relPath} (could not store extraction)`);
          failed++;
        }

        // Rate limit: wait 1 second between API calls
        await new Promise((r) => setTimeout(r, 1000));
      } catch (e) {
        console.log(`  FAIL: ${relPath} (extraction error: ${e.message})`);
        failed++;
      }
    }
  }

  console.log(`\n=== Backfill Complete ===`);
  console.log(`Total: ${total} | Extracted: ${extracted} | Skipped: ${skipped} | Failed: ${failed}`);
}

main().catch(console.error);
