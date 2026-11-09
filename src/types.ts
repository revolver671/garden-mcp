/**
 * The Garden MCP Server — Type Definitions
 */

export interface Env {
  // R2 bucket for all garden storage
  GARDEN_BUCKET: R2Bucket;

  // Workers AI binding (embeddings via @cf/baai/bge-base-en-v1.5)
  AI: any;

  // Vectorize index for semantic memory search (768 dims, cosine)
  VECTORIZE: VectorizeIndex;

  // KV namespace for OAuth token storage
  OAUTH_KV: KVNamespace;

  // D1 inverted keyword index (dispatch 073). Terms and paths in plaintext by
  // the operator's ruling, 7 Sep 2026; the memory files themselves stay encrypted in
  // R2. Nothing depends on it being present or full: a missing binding, an
  // unapplied migration or an empty index all fall back to the old scan.
  KWINDEX: D1Database;

  // Estate-wide verb-layer lease (Durable Object).
  // Spec: athena/verb-layer-lease-spec-v1.md, rulings 29 Aug 2026.
  LEASE: DurableObjectNamespace;

  // OAuth provider helpers (injected by @cloudflare/workers-oauth-provider)
  OAUTH_PROVIDER: OAuthHelpers;

  // Secrets (set via `wrangler secret put`)
  ENCRYPTION_KEY: string;       // Base64-encoded AES-256 key
  GARDEN_ADMIN_KEY?: string;    // Blocking /run-nightly trigger (forge-held)
  GARDEN_READ_KEY?: string;     // /ro/* read-only routes (dispatch 070). A
                                // DIFFERENT value from GARDEN_ADMIN_KEY: this
                                // one is copied onto executor boxes, and the
                                // admin key must stay 401 on /ro/*.
  GARDEN_WRITE_KEY?: string;   // /rw/append only (19 Sep 2026). A
  //   DIFFERENT value from GARDEN_READ_KEY: the read key must
  //   never be able to write, so the two are never the same
  //   secret. Append-only, athena/ only.
  OURA_ACCESS_TOKEN: string;    // Oura Ring personal access token
  LOGIN_PASSWORD_HASH: string;  // SHA-256 hex hash of login password
  ANTHROPIC_API_KEY: string;    // Anthropic API key for Sonnet extraction
  CRONOMETER_USERNAME: string;  // Cronometer login email
  CRONOMETER_PASSWORD: string;  // Cronometer login password
  WITHINGS_CLIENT_ID: string;   // Withings OAuth client ID
  WITHINGS_CLIENT_SECRET: string; // Withings OAuth client secret
  WITHINGS_ACCESS_TOKEN: string;  // Withings OAuth access token (auto-refreshed)
  WITHINGS_REFRESH_TOKEN: string; // Withings OAuth refresh token
  GARMIN_ACCESS_TOKEN: string;    // Garmin DI OAuth access token (auto-refreshed)
  GARMIN_REFRESH_TOKEN: string;   // Garmin DI OAuth refresh token
}

// Type stub for the OAuthHelpers injected by the library
// Full API: parseAuthRequest, completeAuthorization, lookupClient, etc.
interface OAuthHelpers {
  parseAuthRequest(request: Request): Promise<OAuthReqInfo>;
  completeAuthorization(options: {
    request: OAuthReqInfo;
    userId: string;
    metadata?: Record<string, unknown>;
    scope: string[];
    props: Record<string, unknown>;
  }): Promise<{ redirectTo: string }>;
  lookupClient(clientId: string): Promise<Record<string, unknown> | null>;
  createClient(options: Record<string, unknown>): Promise<Record<string, unknown>>;
  listGrants(userId: string): Promise<Array<Record<string, unknown>>>;
  revokeGrant(grantId: string): Promise<void>;
}

interface OAuthReqInfo {
  responseType: string;
  clientId: string;
  redirectUri: string;
  scope: string[];
  state: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}
