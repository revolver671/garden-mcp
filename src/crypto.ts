/**
 * The Garden — Encryption Layer
 * AES-256-GCM via Web Crypto API (native to Cloudflare Workers)
 *
 * Format: [12-byte IV] + [ciphertext + GCM tag]
 * Key: imported from base64 Worker Secret
 */

let _cachedKey: CryptoKey | null = null;

async function getKey(base64Key: string): Promise<CryptoKey> {
  if (_cachedKey) return _cachedKey;

  const raw = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
  _cachedKey = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  return _cachedKey;
}

export async function encrypt(
  plaintext: string,
  base64Key: string
): Promise<ArrayBuffer> {
  const key = await getKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded
  );

  // Prepend IV to ciphertext
  const result = new Uint8Array(iv.length + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), iv.length);
  return result.buffer;
}

export async function decrypt(
  data: ArrayBuffer,
  base64Key: string
): Promise<string> {
  const key = await getKey(base64Key);
  const bytes = new Uint8Array(data);

  const iv = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(decrypted);
}
