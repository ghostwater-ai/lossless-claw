# PRODUCT.md — Lossless-Claw (Ghostwater Fork)

## What It Is

Lossless Context Management (LCM) plugin for OpenClaw — DAG-based conversation summarization with incremental compaction and cross-session ambient awareness. Fork of [Martian-Engineering/lossless-claw](https://github.com/Martian-Engineering/lossless-claw) (MIT license, v0.3.0).

**Target user:** OpenClaw operators running multi-agent, multi-channel setups where conversations span days/weeks and agents need awareness across parallel sessions.

**Core value proposition:** Agents never lose context. Within a session, older messages compress into a lossless summary DAG that's drillable on demand. Across sessions, lightweight ambient beacons give agents gentle awareness of parallel and prior conversations without displacing active working memory.

## Current State

### What Works Today

**Upstream features (inherited):**
- LSM-structured summarization DAG — raw messages → depth-0 leaf summaries (~40x compression) → depth-1+ condensed summaries
- Incremental compaction triggered by token budget pressure (leaf trigger at 20k tokens, threshold trigger at 75% of context window)
- Materialized frontier via `context_items` table — assembly reads flat ordinal list, never traverses DAG
- Drill-down tools: `lcm_grep` (regex/FTS search), `lcm_describe` (metadata lookup), `lcm_expand_query` (delegated sub-agent expansion with cited summary IDs)
- Fresh tail protection — last 8 context items immune from compaction
- Heartbeat pruning, transcript repair, large file handling
- 21 test files, 297+ assertions passing

**Our patches (9 commits on `patches` branch, +1,799 / -70 lines):**
- **Cross-session ambient beacons (Shape E)** — one incremental beacon per conversation, injected into other sessions' assembly within a configurable token budget (default 10k). Beacons are relevance indices, not context replacements — the full conversation DAG is always drillable via `lcm_expand_query`.
- **`conversation_digests` table** — stores per-conversation beacon text (120-160 tokens), agent scope, provider, source label, timestamps. Updated incrementally in `afterTurn()` (existing digest + new messages, not full re-summarization).
- **Agent-scoped isolation** — conversations tagged with `agent_scope` extracted from OpenClaw session key. Hard wall between agents. Each agent only sees its own conversations' beacons.
- **Conversation metadata** — `provider` (slack/telegram/discord) and `source_label` (channel/group name) stored for platform-aware ambient context display.
- **Subagent session filtering** — subagent sessions skip digest generation entirely; their outcomes are captured by parent session beacons.
- **Beacon prompt tuning** — purpose-first framing ("what this session IS ABOUT") before recent activity details.
- **Stable checkpointing** — beacon updates track progress via `last_message_id` (stable across compaction) instead of ordinals (which shift).

### What's Broken, Blocked, or Incomplete

- **Thread beacons can duplicate channel beacons** — Slack threads get their own sessions, producing separate beacons that may overlap with the channel beacon. Not harmful but wastes ambient budget at scale. No filter yet.
- **No topic-shift detection** — beacons update incrementally based on message count, not semantic change. A long-running session that shifts topics mid-conversation produces a beacon blending both topics.
- **Pure recency sorting** — ambient beacons are packed by most recent activity. No relevance scoring based on current conversation topic.
- **TypeScript type errors** — pre-existing SDK/type-surface mismatches cause `tsc --noEmit` to fail. Not a runtime issue (jiti transpiles on the fly).
- **Vitest worker timeout** — test suites pass assertions but Vitest occasionally hangs on worker cleanup, causing non-zero exit.

### Last Meaningful Activity

- 2026-03-18: Cross-session beacons deployed to production, three post-deployment fixes (agent scope parsing, beacon prompt, subagent filter) pushed to `patches`.
- 2026-03-17: PR #1 merged — Shape E implementation (4 stories, 3 review-fix cycles via Soulforge).

## Architecture

### Key Components

```
┌─────────────────────────────────────────────────────────┐
│ OpenClaw Runtime                                         │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────┐ │
│  │ Bootstrap     │   │ Ingest       │   │ AfterTurn   │ │
│  │ (JSONL seed)  │   │ (per message)│   │ (compaction │ │
│  │               │   │              │   │  + digests)  │ │
│  └──────┬───────┘   └──────┬───────┘   └──────┬──────┘ │
│         │                   │                   │        │
│  ┌──────┴───────────────────┴───────────────────┴──────┐ │
│  │              ContextEngine (engine.ts)                │ │
│  │  - Session-scoped conversation management            │ │
│  │  - Compaction orchestration (leaf + condensed)       │ │
│  │  - Digest updates (cross-session beacons) ← NEW     │ │
│  │  - Assembly (intrasession + ambient) ← NEW           │ │
│  └──────────────────────┬──────────────────────────────┘ │
│                         │                                 │
│  ┌──────────────────────┴──────────────────────────────┐ │
│  │              SQLite Database (lcm.db)                 │ │
│  │  - conversations (session_id, agent_scope, provider) │ │
│  │  - context_items (materialized frontier)              │ │
│  │  - summaries + summary_parents (DAG)                  │ │
│  │  - message_parts (raw content)                        │ │
│  │  - conversation_digests (ambient beacons) ← NEW       │ │
│  └──────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### Tech Stack

- **Language:** TypeScript (compiled via jiti at runtime, no build step)
- **Database:** SQLite (via better-sqlite3), single file at `~/.openclaw/lcm.db`
- **Summarization:** Uses OpenClaw's configured model (typically Claude) via the host's message provider
- **Plugin interface:** Implements OpenClaw's `ContextEngine` interface (`bootstrap`, `ingest`, `afterTurn`, `assemble`, `compact`, `dispose`)
- **Test framework:** Vitest

### Deployment

- Loaded by OpenClaw via `plugins.load.paths` pointing to the local clone
- Occupies the `memory` plugin slot (exclusive — displaces `memory-core` when active)
- No standalone deployment — runs in-process with OpenClaw gateway
- Production: `/home/miner/projects/lossless-claw` on ore-01

### External Dependencies

- **Upstream:** [Martian-Engineering/lossless-claw](https://github.com/Martian-Engineering/lossless-claw) — `main` branch mirrors upstream, `patches` branch holds our changes
- **OpenClaw:** Host runtime provides session management, model access, tool registration, hook system
- **better-sqlite3:** Database driver

## Delta from Upstream

| Area | Upstream | Our Fork |
|------|----------|----------|
| Session awareness | Single-session only | Cross-session ambient beacons |
| Agent identity | None (session UUID only) | `agent_scope` on conversations, extracted from session key |
| Assembly | Intrasession context items | Intrasession + ambient beacon injection within budget |
| Digest table | Does not exist | `conversation_digests` with incremental updates |
| Conversation metadata | `session_id` only | `agent_scope`, `provider`, `source_label` columns |
| Subagent handling | No distinction | Subagent sessions skip digest generation |
| Beacon formatting | N/A | Purpose-first XML beacons with provider/label metadata |

**Upstream issues filed:** None (LCM doesn't have an issue tracker enabled on GitHub). Changes are fork-only for now.

## Gap Analysis

### High Impact

1. **Upstream contribution path** — Our patches are fork-only. No upstream PR exists. Need to determine whether Martian-Engineering accepts contributions and prepare a PR if so. Risk: fork divergence grows with each upstream release.

2. **Thread beacon deduplication** — Thread sessions produce beacons that may overlap with channel beacons. At scale (many threads), this wastes ambient budget. Need either: thread beacons rolled into parent channel beacon, or thread sessions filtered like subagents.

3. **Relevance-based beacon selection** — Pure recency sorting means a 2-week-old active conversation always ranks above a yesterday conversation that's topically relevant. Semantic similarity between current conversation and beacon content would improve signal.

### Medium Impact

4. **TypeScript type surface** — Pre-existing `tsc` failures from SDK mismatches. Blocks strict CI enforcement. Not a runtime problem but a maintenance burden.

5. **Vitest worker timeout** — Flaky test exit codes. All assertions pass but CI would flag as failure. Needs investigation (likely open handles or timers).

6. **Beacon size tuning** — Current 120-160 token target was chosen during shaping but not validated with data. May need adjustment based on real-world beacon utility.

### Low Impact

7. **Topic-shift detection** — Beacons blend topics when sessions shift focus. A future improvement could detect semantic shifts and restructure the beacon. Deferred — incremental updates are good enough for v1.

8. **Cross-conversation drill-down ergonomics** — `lcm_expand_query` works across conversations with `allConversations: true`, but targeting a specific beacon's conversation requires knowing the conversation ID. Could add a shortcut tool or parameter.

## Next Actions

1. **Monitor beacon utility in production** — Observe whether agents naturally reference cross-session context. If beacons are consistently ignored, revisit size/content/placement. *(Ongoing, no blocker)*

2. **Sync upstream** — Pull latest from Martian-Engineering/lossless-claw into `main`, rebase `patches`. Check for conflicts with our schema additions. *(Next upstream release)*

3. **Fix TypeScript type surface** — Align SDK types to unblock `tsc --noEmit`. *(Medium effort, no blocker)*

4. **Evaluate thread beacon strategy** — Collect data on thread beacon count and overlap. Decide filter vs. rollup vs. keep. *(After more production data)*

5. **Explore upstream contribution** — Check if Martian-Engineering accepts PRs. If yes, prepare cross-session beacons as a feature PR. *(When patches stabilize further)*
