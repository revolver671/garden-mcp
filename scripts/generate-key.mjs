/**
 * Generate secrets for The Garden MCP server
 *
 * Run: node scripts/generate-key.mjs
 *
 * Outputs:
 *   - AES-256 encryption key (base64)
 *   - Auth token (hex)
 *
 * Then set these as Cloudflare Worker secrets:
 *   npx wrangler secret put ENCRYPTION_KEY
 *   npx wrangler secret put AUTH_TOKEN
 *   npx wrangler secret put OURA_ACCESS_TOKEN
 */

import { webcrypto } from "node:crypto";

// Generate AES-256 key
const key = await webcrypto.subtle.generateKey(
  { name: "AES-GCM", length: 256 },
  true,
  ["encrypt", "decrypt"]
);
const exported = await webcrypto.subtle.exportKey("raw", key);
const base64Key = Buffer.from(exported).toString("base64");

// Generate auth token
const tokenBytes = new Uint8Array(32);
webcrypto.getRandomValues(tokenBytes);
const authToken = Buffer.from(tokenBytes).toString("hex");

console.log("=== The Garden MCP — Generated Secrets ===\n");
console.log("ENCRYPTION_KEY (base64, AES-256):");
console.log(base64Key);
console.log("\nAUTH_TOKEN (hex, 256-bit):");
console.log(authToken);
console.log("\n=== Save these securely! ===");
console.log("\nSet as Worker secrets:");
console.log(`  npx wrangler secret put ENCRYPTION_KEY`);
console.log(`  npx wrangler secret put AUTH_TOKEN`);
console.log(`  npx wrangler secret put OURA_ACCESS_TOKEN`);
console.log("\nFor the Claude.ai MCP connector, use this auth header:");
console.log(`  Authorization: Bearer ${authToken}`);
