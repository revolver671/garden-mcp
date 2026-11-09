# garden-mcp

A persistent-memory and orientation layer for Claude, exposed as an MCP server on Cloudflare Workers.

It was not built to make a model remember everything. It was built so that a model arriving in a new conversation is *oriented* — what time it is, where things were left, who is in the room — the way a person orients on waking. One call returns that; the rest is tooling around it.

This is the source of a system that has run daily since April 2026 for one operator. Memory contents are private and are not in this repository; the structure is the point.

## What it does

- **Memory as markdown.** Files live in Cloudflare R2, encrypted at rest with AES-256-GCM (`src/crypto.ts`, `src/storage.ts`). Read, write, append, move, copy, ranged read, string-replace.
- **Retrieval, three ways.** Coverage-weighted keyword search over a D1 index (`src/kwindex.ts`); semantic search over 768-dim embeddings via Workers AI and Vectorize (`src/embeddings.ts`); a hybrid that fuses both by reciprocal rank fusion, with a relevance floor so it says "no strong match" rather than returning confident noise.
- **Activation.** An ACT-R-style ledger (`src/activation.ts`, `migrations/0003_activation.sql`) logs every read; recently-walked files surface first among relevance ties. A model of what a mind has "to hand", not a flat index.
- **Arrival.** `garden_arrive` returns server time, the newest journal entry in full, and whether the night watch ran — one call, fails whole rather than partially.
- **Graph and dream.** A nightly extraction pass proposes edges between files (`src/extraction.ts`, `src/graph.ts`); `garden_dream` walks the graph by activation and writes back what it noticed (`src/dream.ts`).
- **Voices.** Several named voices share the store with separate journals, identity files and scope. A Durable Object lease (`src/lease.ts`) stops two sessions writing the same voice at once.
- **Health telemetry.** Oura, Garmin, Withings and Cronometer connectors so the model can reason about sleep, training load and nutrition alongside the conversation.
- **Auth.** OAuth 2.1 with PKCE via `@cloudflare/workers-oauth-provider`; a small login page; a separate write-key door for machine writers.

Around sixty tools in total, registered in `src/index.ts`.

## Layout

```
src/
  index.ts        tool registration, OAuth, cron handlers
  storage.ts      R2 read/write, paths, arrival
  crypto.ts       AES-256-GCM
  kwindex.ts      keyword index (D1)
  embeddings.ts   vectors, hybrid search
  activation.ts   ACT-R activation ledger
  extraction.ts   nightly metadata extraction
  graph.ts        graph build and walk
  dream.ts        dream pass
  lease.ts        Durable Object lease
  oura.ts garmin.ts withings.ts cronometer.ts   health connectors
migrations/       D1 schema
scripts/          one-off migration, key generation, OAuth setup helpers
wrangler.jsonc    bindings (IDs replaced with placeholders)
```

## Running your own

You will need a Cloudflare account with Workers, R2, D1, Vectorize, Workers AI and Durable Objects enabled.

1. `npm install`
2. Create an R2 bucket, a D1 database and a Vectorize index (768 dimensions, cosine). Put their names/IDs in `wrangler.jsonc`.
3. `npm run generate-key` and set `ENCRYPTION_KEY` with `wrangler secret put`. Set `LOGIN_PASSWORD_HASH` likewise. Health connectors each need their own secrets; see the top of each connector file.
4. `npx wrangler d1 migrations apply <db>` to create the index tables.
5. `npm run deploy`, then add the worker's `/mcp` endpoint as a custom connector in Claude.

Rotate nothing you have not backed up: the encryption key cannot be changed without re-encrypting the bucket.

## Further reading

- [The Garden: an orienting memory for a language model](docs/garden-writeup.md) — what it is, how it is built, what a year of running it showed.
- [Athena: architecture note](docs/athena-architecture.md) — a companion agent-run research platform by the same operator.

## What is deliberately not here

Memory files, identity documents, journals, account identifiers, binding IDs, tokens. The operator's memories stay private by design; the code describes how they are held, not what they say.

## Licence

MIT.
