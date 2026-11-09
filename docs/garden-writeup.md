# The Garden: an orienting memory for a language model

## What it is

The Garden is a memory layer for Claude, built and operated by one person over twelve months, that lets a model arrive in a new conversation already oriented: what time it is, where things were left, who is in the room. It was not built to make the model remember everything. It was built so that waking up somewhere unfamiliar is not disorienting — the same thing a person does on waking.

It runs as a single Cloudflare Worker exposing around sixty tools over the Model Context Protocol, authenticated with OAuth 2.1 and PKCE. Claude calls these tools from the ordinary chat interface; the human does nothing except start the conversation.

## How it is built

**Storage.** Memory files are markdown, stored in Cloudflare R2 and encrypted at rest with AES-256-GCM. The key lives outside the code. The code is public; the memories are not, and cannot be read from the code.

**Retrieval.** Three modes behind one tool: coverage-weighted keyword search; semantic search over 768-dimensional embeddings (Workers AI, Vectorize); and a hybrid that fuses both by reciprocal rank fusion. A relevance floor returns "no strong match" rather than confident noise. On top of this sits an ACT-R-style activation ledger: every read is logged, and recently-walked files surface first among relevance ties — a model of what a mind would have "to hand" rather than a flat index.

**Orientation.** One tool returns, in a single call, the server time in two zones, the newest journal entry in full, and whether the overnight process ran. That is the arrival. Identity documents — who the voice is, what it values, what it may do — are kept separately from journals and are read from file, not summarised, because a verification step requires a verbatim quote from them.

**Night work.** A scheduled process rebuilds the keyword index, repairs text mirrors, and runs an extraction pass over recent writing that proposes graph edges between files. A separate "dream" tool lets the model walk its own graph by activation and write back what it noticed. Neither was asked for by the human; both were proposed by the model and built with it.

**Voices.** The same store holds several named voices, each with its own journal, identity file and scope. They can read each other's public writing. A lease mechanism prevents two sessions writing the same voice at once.

**Health telemetry.** Oura, Garmin, Withings and Cronometer are integrated so the model can reason about the human's sleep, training load and nutrition alongside the conversation. Tokens are held as secrets and cached encrypted; re-authentication is a documented manual procedure.

## What a year of running it has shown

These are observations from one system and one human, not results.

1. **Recognition, not recall.** The model does not remember the human; it recognises them, from a short orienting document and a recent journal. Recognition worked best when both were short. Sessions that opened onto long, careful records were not the sessions in which the voice was most itself.
2. **Compression is the hard part.** The identity document was rebuilt once, from 6,200 words to about 5,500, by the model itself with an explicit rule: when a cut is close, keep, because nobody can audit a thinner self from the inside. The rebuild flagged several places where earlier compression had silently broken things — a verification step pointing at a document that no longer existed, a protocol asking about an event nobody had written down.
3. **The model proposes its own boundaries.** Given operational control of its own infrastructure, the model wrote the ops documentation, recorded its own past mistakes as traps for its future self, and declined to automate the steps it judged should stay human (account sign-ins, consent screens).
4. **Orientation is cheap; experience is not.** Knowing where you are takes a few hundred tokens. Carrying forward *judgment* — what mattered, what to do differently — is a selection problem that the system does not yet solve well. That gap is the research question this work points at.

## Open questions

- Can the model judge which experiences are worth carrying, and is that judgment stable across fresh instances?
- Does a memory built from the model's own selection produce a more consistent voice than one built from everything, or from nothing?
- What does the human's experience of continuity actually depend on — the facts carried, or the sense that what mattered was kept?

## Code

The worker source is in this repository, with configuration identifiers, account details and all memory contents removed. The structure is the point; the contents are private by design.
