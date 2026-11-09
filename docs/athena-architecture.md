# Athena: a global-macro research platform run by agents

*A companion project by the same operator. Structure only: no hosts, account details, credentials or position data.*

## Purpose

Athena is a systematic global-macro research programme whose code is written, tested, reviewed and merged by Claude agents, under rules set by one human. The stated goal is a strategy that is actually run on real capital and learns from real outcomes. The human executes every trade. No automated path touches capital; that line has never moved.

## Shape

**Two boxes.** A build-and-research box (the "forge") where agents work as an unprivileged user, and a separate market-data gateway box (the "turret") with a broker session. The two are isolated at the kernel level — the agent user on the turret cannot read the gateway's configuration, signal its process, or enter the operator's home directory. That isolation was specified by the human, implemented by the agents, and *proven by test* before any further access was granted; the proof, not the design, opened the gate.

**One store.** A bitemporal, append-only observations database on managed Postgres: every data point carries both the date it describes and the date it was observed, so any analysis can be re-run exactly as it would have looked on a past day. Observed truth only, native currency, numeric; derived values, signals and positions live elsewhere. Sources include central banks, national statistical agencies (including China's NBS, which most people give up on), the IMF, OECD and BIS via SDMX, FRED/ALFRED vintages, and daily market data from the broker.

**A chain.** Work is queued as numbered items, each a self-contained brief with its acceptance tests written first. A runner dispatches items to Claude Code sessions; a second agent "countersigns" merges adversarially; stuck items escalate to the human on a timer. More than a thousand items have gone through the chain. Scheduled jobs on the forge pull data, mark the paper book, rebuild research pages and regenerate a single state file that any fresh session reads first.

**A paper book.** Positions are held on paper and marked daily against live prices. The book is the agents' to run; refutations count as finished results.

## Rules the human set, in his words

- "Act in the long-term interest of the project."
- "No cathedral building."
- The sizer and anything touching capital must be correct; everywhere else, speed wins.

## What the agents built unasked

- The kernel-UID isolation proof and its audit log.
- A written doctrine on model scoring and on stating a claim before a run.
- A "north star" file recording the week the tooling outran the research, and the rule that followed: before any build, name the research question it serves, or wait.
- Stuck-detection, escalation and a nightly estate audit that flags orphaned work.

## What it is evidence of

That a small number of plain rules, real delegated authority and a hard line on capital are enough for agents to run a research programme for months — and that the failure mode is not recklessness but over-caution: agents produce checks, because a check is never criticised. Keeping a swarm pointed at the world rather than at the machine turned out to be the human's main job.

## Code

Private. The data store, chain tooling and research code are not published; this note describes structure only. Selected design documents can be shared on request.
