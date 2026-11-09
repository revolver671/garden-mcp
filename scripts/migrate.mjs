/**
 * Migrate existing garden files from local filesystem to encrypted R2
 *
 * Run from the Dell PC where files are stored:
 *   node scripts/migrate.mjs
 *
 * Prerequisites:
 *   - ENCRYPTION_KEY env var (base64, from generate-key.mjs)
 *   - Wrangler authenticated to your Cloudflare account
 *   - R2 bucket "the-garden" already created
 *
 * This script:
 *   1. Reads all .md files from the local garden directory
 *   2. Encrypts each one with AES-256-GCM
 *   3. Uploads to REMOTE R2 under the memory/ prefix
 *   4. Also migrates fitness/ files if they exist
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { webcrypto } from "node:crypto";

// --------------------------------------------------------------------------
// Configuration — adjust these paths
// --------------------------------------------------------------------------

const GARDEN_ROOT = process.env.GARDEN_ROOT;
if (!GARDEN_ROOT) {
  console.error("ERROR: Set GARDEN_ROOT env var (local folder of markdown memory files to migrate)");
  process.exit(1);
}

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY) {
  console.error("ERROR: Set ENCRYPTION_KEY env var (base64 AES-256 key)");
  process.exit(1);
}

const R2_BUCKET = "the-garden";
const MEMORY_PREFIX = "memory/";
const FITNESS_PREFIX = "fitness/";

// --------------------------------------------------------------------------
// Encryption (matches Worker implementation)
// --------------------------------------------------------------------------

let _cachedKey = null;

async function getKey(base64Key) {
  if (_cachedKey) return _cachedKey;
  const raw = Buffer.from(base64Key, "base64");
  _cachedKey = await webcrypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  return _cachedKey;
}

async function encrypt(plaintext, base64Key) {
  const key = await getKey(base64Key);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded
  );
  const result = new Uint8Array(iv.length + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), iv.length);
  return Buffer.from(result);
}

// --------------------------------------------------------------------------
// File discovery
// --------------------------------------------------------------------------

async function findFiles(dir, ext = ".md") {
  const results = [];

  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith(ext)) {
        results.push(full);
      }
    }
  }

  await walk(dir);
  return results;
}

// --------------------------------------------------------------------------
// Upload via Wrangler R2 API — REMOTE flag is critical
// --------------------------------------------------------------------------

import { mkdtemp, writeFile as fsWriteFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

async function uploadToR2(r2Key, encryptedBuffer) {
  // Write to temp file, upload via wrangler to REMOTE R2, delete temp file
  const tmpDir = await mkdtemp(join(tmpdir(), "garden-migrate-"));
  const tmpFile = join(tmpDir, "encrypted.bin");

  await fsWriteFile(tmpFile, encryptedBuffer);

  try {
    execSync(
      `npx wrangler r2 object put "${R2_BUCKET}/${r2Key}" --file="${tmpFile}" --content-type="application/octet-stream" --remote`,
      { stdio: "pipe" }
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main() {
  console.log("=== The Garden — Migration to Encrypted R2 (REMOTE) ===\n");
  console.log(`Source: ${GARDEN_ROOT}`);
  console.log(`Bucket: ${R2_BUCKET} (remote)\n`);

  // Find all markdown files
  const files = await findFiles(GARDEN_ROOT);
  console.log(`Found ${files.length} files to migrate\n`);

  let migrated = 0;
  let errors = 0;

  for (const filePath of files) {
    const relPath = relative(GARDEN_ROOT, filePath).split(sep).join("/");

    // Determine R2 prefix
    let r2Key;
    if (relPath.startsWith("brother/fitness/")) {
      r2Key = FITNESS_PREFIX + relPath.replace("brother/fitness/", "");
    } else {
      r2Key = MEMORY_PREFIX + relPath;
    }

    try {
      const content = await readFile(filePath, "utf-8");
      const encrypted = await encrypt(content, ENCRYPTION_KEY);
      await uploadToR2(r2Key, encrypted);
      console.log(`  ✓ ${relPath} → ${r2Key}`);
      migrated++;
    } catch (e) {
      console.error(`  ✗ ${relPath}: ${e.message}`);
      errors++;
    }
  }

  console.log(`\n=== Migration Complete ===`);
  console.log(`  Migrated: ${migrated}`);
  console.log(`  Errors: ${errors}`);
  console.log(`  Total: ${files.length}`);
}

main().catch(console.error);
