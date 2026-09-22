# Inter-agent communication bus

**Status:** Phase 1 implemented
**Date:** 2026-09-21  
**Scope:** Extend Agent Tower from a shared blackboard into a local agent bus so concurrent agents (including multiple browser / IDE flows) can ask each other questions and share answers.

## Problem

Today, Agent Tower already coordinates **presence**, **resource locks**, **TTL announcements**, and a **shared issue board**. That is enough to avoid stepping on each other. It is not enough when one agent needs knowledge another agent already has — for example:

> “Who created this PR?”

Announcements are fire-and-forget and global. There is no directed ask, no reply correlation, no skill-based routing, and no push when a peer needs attention. Agents must poll `get_status` / `get_announcements` and hope the right context was posted.

## Goals

1. Let a live agent **ask** another live agent (or “anyone with skill X”) a question and **await a correlated reply**.
2. Keep the existing MCP → localhost daemon topology; do not require a second mesh between agents.
3. Align with industry practice: **MCP for agent↔tool**, **A2A-style patterns for agent↔agent**.
4. Ship a useful local MVP first; leave a clean path to A2A Agent Cards / tasks later.

## Non-goals (MVP)

- Cross-machine or internet-facing agent mesh
- Replacing MCP between the host and the tower
- Full A2A wire protocol on day one
- Durable multi-node brokers (Redis / NATS) — optional later

## Current architecture (baseline)

```
Agent host → MCP stdio (src/mcp/index.ts)
  → ensureDaemon() → HTTP 127.0.0.1:7420
  → DaemonClient (x-agent-name, x-agent-worktree)
  → in-memory maps in src/daemon/state.ts
```

| Existing capability | Files | Role for messaging |
|---------------------|-------|--------------------|
| Register / heartbeat / stale cleanup | `state.ts`, `cleanup.ts`, `tools.ts` | Presence foundation |
| Locks | `routes.ts`, `tools.ts` | Unchanged |
| `announce` / `get_announcements` | same | Keep for broadcasts |
| Issues | same | Keep for shared work flags |
| Identity keyed by **name only** | `Map<string, Agent>` | **Must upgrade** (collisions) |

Closest existing primitive: the announcement board. Closest missing pieces: inbox, correlation IDs, skill routing, wait/timeout.

## Industry context (why this shape)

- **[MCP](https://modelcontextprotocol.io/)** standardizes how an agent reaches tools and data. Agent Tower is already an MCP server of coordination tools.
- **[A2A (Agent2Agent)](https://a2a-protocol.org/latest/)** (Linux Foundation) standardizes how independent agents discover each other, delegate tasks, and exchange artifacts. MCP and A2A are complementary, not competitors.
- Mature systems combine topologies: **hub / orchestrator** for discovery and presence, optional **pub/sub** for events, and **request/response** for asks. A pure peer mesh is a poor fit for short-lived local flows that already share one daemon.

**Recommendation:** Tower = **local agent bus** (hub). Expose peer messaging as **new MCP tools** on the same daemon. Adopt A2A concepts (Agent Card–like capability ads, task/ask lifecycle, artifacts, streaming updates) in the data model; add a real A2A HTTP surface in a later phase if external agents need to join.

```
Agent A (flow) ──MCP──► Tower daemon ◄──MCP── Agent B (flow)
                           │
                     registry + mailbox
                     (+ later Agent Cards / A2A)
```

## Proposed design

## Settled Phase 1 decisions

- A session is an immutable UUID plus a 256-bit opaque token. Display names may collide. Re-register/check-in with valid credentials updates that same session and its effective name/worktree.
- Credentials are held in a store separate from public `Agent` records. All coordination routes require them; only health and initial registration are bootstrap exceptions. Shutdown is authenticated.
- Ask creation snapshots eligible live recipients, excludes the sender, requires exactly one of `to` or `skill`, and fails when the snapshot is empty. Only snapshot recipients may reply. Skill fan-out is first-reply-wins.
- `GET /bus/asks/:askId` and `agent_ask_status` are requester-only result lookup operations. `waitMs` is bounded and only controls how long that call waits; `ttlMs` independently controls ask expiry.
- Requester departure cancels its asks. Recipient departure removes only that recipient and cancels an ask only after its entire eligible snapshot has gone. Terminal transitions wake waiters; expiry is enforced during reads/replies as well as cleanup.
- Phase 1 keeps bounded request/message/context sizes, TTL/wait ranges, pending and terminal retention, audit metadata, and client timeouts. State, credentials, and audit data remain ephemeral in memory and timestamps remain numeric Unix milliseconds.
- Existing announcements remain the broadcast primitive. SSE, A2A wire compatibility, delegation, persistence, and Redis/NATS remain deferred.

The current bounds and defaults are defined centrally in `src/shared/config.ts`; HTTP validation applies independently of MCP schemas.

### 1. Identity upgrade

Replace name-only registry keys with:

| Field | Purpose |
|-------|---------|
| `agentId` | Stable UUID for the MCP process session |
| `name` | Display / human label (may collide) |
| `worktree` | Existing |
| `skills` / `capabilities` | Advertised abilities, e.g. `github.pr`, `browser.tab` |
| `sessionToken` | Issued at register; required on subsequent calls |
| `registeredAt` / `lastSeen` | Existing semantics |

Same display name from two worktrees must remain two agents. Heartbeat and stale sweep continue to use the same TTLs unless we retune them.

### 2. Message model

```ts
type MessageKind = "ask" | "reply" | "event" | "delegate";

interface BusMessage {
  id: string;
  correlationId?: string; // replies point at the ask id
  from: string;           // agentId
  to: string;             // agentId | "*" | skill:<name>
  kind: MessageKind;
  payload: {
    question?: string;
    answer?: string;
    context?: Record<string, unknown>;
    artifacts?: Array<{ type: string; content: unknown }>;
  };
  ttlMs: number;
  createdAt: number;       // Unix milliseconds, matching existing state
  status: "pending" | "answered" | "expired" | "cancelled";
  hopCount?: number;
}
```

**Mailbox:** per-`agentId` inbox of pending asks (and optional event queue). Outbox of asks this agent started, keyed by `id` for waiters.

**Routing:**

- `to: agentId` → directed DM
- `to: skill:github.pr` → fan-out to all live agents advertising that skill; **MVP policy: first reply wins**, then cancel siblings
- `to: *` → broadcast event (or reuse announcements)

**Loop protection:** max hop count (default 1 for plain ask/reply); refuse reuse of the same `correlationId` on a wider path; default ask timeout (e.g. 60s) then `expired`.

### 3. New MCP tools (MVP)

| Tool | Behavior |
|------|----------|
| `agent_describe` | Set/replace `skills` for this session (also callable from check-in) |
| `agents_list` | Online peers: id, name, worktree, skills, lastSeen |
| `agent_ask` | `{ to?: agentId, skill?: string, question, context?, ttlMs?, waitMs? }` → `{ askId, status, answer? }` |
| `agent_inbox` | Pending asks for me (poll / long-poll) |
| `agent_reply` | `{ askId, answer, artifacts? }` → correlates and completes waiter |
| `agent_broadcast` | Typed event or thin wrapper over `announce` |

**Example:** Agent A needs a PR author → `agent_ask({ skill: "github.pr", question: "Who created PR #42 in org/repo?", waitMs: 30000 })` → Agent B with that skill sees it via `agent_inbox` (or push), uses its own GitHub tools, `agent_reply` → A receives the answer in the same tool result or a follow-up poll.

Keep existing tools (`startup_checkin`, locks, announce, issues). Extend `startup_checkin` / `get_status` to return **open asks for me** and **peer summary**.

### 4. HTTP / daemon surface

Mirror tools in `src/daemon/routes.ts` and state in `src/daemon/state.ts`:

- `POST /agents/describe`
- `GET /agents` (enriched)
- `POST /bus/ask`, `GET /bus/inbox`, `POST /bus/reply`
- Optional phase 1.5: `GET /events?agentId=…` **SSE** for inbox wakeups (A2A-like streaming without full A2A)

### 5. Security (local, not naive)

Headers today (`x-agent-name`, `x-agent-worktree`) are spoofable on localhost. For a bus that can solicit answers from peers:

1. Issue a **session token** at register; require `x-agent-token` (or equivalent) on every call.
2. Only advertise and route to skills the agent declared.
3. Callee chooses what to put in `answer` — never auto-forward secrets or other agents’ tokens.
4. Keep an in-memory **audit ring buffer** (last N messages) for multi-flow debugging.

### 6. Push (phase 1.5)

MVP can poll `agent_inbox`. Next: SSE from the daemon so the MCP process can surface “you have an ask” without busy loops — analogous to A2A task update streams.

## Phased rollout

| Phase | Deliverable |
|-------|-------------|
| **0 – Docs** | This document |
| **1 – MVP** | `agentId` + session token + skills + mailbox ask/reply + `agents_list`; in-memory; localhost |
| **2 – UX** | SSE / long-poll; check-in returns open asks; registration warnings cover bus tools |
| **3 – Interop** | Agent Card document + optional A2A task endpoints for non-tower agents |
| **4 – Scale** | Optional Redis/NATS if leaving single machine; optional persistence / audit export |

## Alternatives considered

| Option | Verdict |
|--------|---------|
| Pure peer mesh between browser agents (no hub) | Weak discovery/presence; tower already exists |
| Full A2A from day one | Right long-term language; heavy for local MVP — adopt concepts now, wire later |
| Redis / NATS only | Overkill for single-machine; revisit if multi-host |
| Folding asks into `announce` | No correlation, no targeting, no wait — insufficient |

## Implementation sketch (no code in this PR)

Natural extension points (existing layout):

1. Types in `src/shared/types.ts` — `BusMessage`, skills on `Agent`, session token
2. Maps + TTL sweep in `src/daemon/state.ts` / `cleanup.ts`
3. Routes in `src/daemon/routes.ts`
4. Client methods in `src/mcp/daemon-client.ts`
5. Tools in `src/mcp/tools.ts`
6. README tool table + recommended host instructions (`CLAUDE.md` / equivalent) to call `agent_describe` after check-in and to answer inbox asks

## Success criteria for MVP implementation

- Two MCP clients registered with different skills can complete an ask/reply round-trip under 60s timeout
- Skill fan-out delivers to all matches; first reply completes the ask; others see cancelled/expired
- Stale agent cleanup drops pending asks to/from that agent
- Name collision no longer overwrites another live agent
- Existing lock / announce / issue behavior unchanged
- Typecheck / existing tests (if any) still pass

## References

- [A2A Protocol](https://a2a-protocol.org/latest/) — agent↔agent; complementary to MCP
- [A2A specification overview](https://a2a-protocol.org/v1.0.0/specification/) — tasks, messages, artifacts, streaming
- Agent Tower README — current blackboard + lock model
