# Conductor — Architecture Design

## What Is Conductor?

Conductor is a **local session manager** that runs alongside the Happy daemon on the user's machine. It exposes itself as a special Happy session so the mobile app can talk to it via the normal session UI — no app changes needed.

The user's goal is **voice-first vibe coding**: monitor all running Claude Code sessions, get spoken summaries, and send commands to any session — hands-free from their phone.

Conductor is **not**:
- A goal tracker or todo list (that belongs in the session itself)
- A cross-machine orchestrator (runs on one machine, sees that machine's sessions)
- A conversation assistant (does not use LLM for command routing — only for fuzzy session identification and summarization)

---

## Core Architectural Principle

```
Action  = a pure, named, async operation (reads/writes SQLite + calls external services)
Trigger = anything that calls an action (user message, timer, socket event, app open, ...)

Actions and triggers never know about each other.
```

This mirrors Redux: the `fetchSessions` action is the same function whether it is called by a user message, a background timer, or a CLI flag. Wiring triggers to actions happens in `index.ts` only.

---

## Data Flow

```
User speaks → STT → text sent to Conductor session on Happy server
                                    ↓
                         ConductorSession (socket)
                                    ↓
                         Load sessions + conversation from SQLite
                                    ↓
                         LLMTranslator: build prompt → call AI → Zod-validate JSON
                                    ↓
                         ActionExecutor: run the action
                                    ↓
                         Write result to SQLite (action_log, sessions)
                                    ↓
                         Reply to user (plain spoken English)
```

---

## Action Catalog

Every action is a typed async function. Triggers call these functions — they do not know who triggered them.

```typescript
type Actions = {
  // Session registry
  fetchSessions:    ()                                                     => Promise<void>;

  // Communication to a specific session
  sendToSession:    (sessionId: string, message: string)                   => Promise<void>;
  interrupt:        (sessionId: string)                                    => Promise<void>;
  grantAccess:      (sessionId: string, requestId: string, allow: boolean) => Promise<void>;

  // Derived work (calls AI internally)
  summarizeSession: (sessionId: string)                                    => Promise<string>;

  // Lifecycle
  spawnSession:     (directory: string)                                    => Promise<string>; // returns new sessionId
};
```

### Action Semantics

| Action | What it does | Differs from |
|---|---|---|
| `fetchSessions` | GET /v1/sessions → decrypt metadata → upsert sessions table | — |
| `sendToSession` | Encrypt + POST user-role message. Agent reads it when current work finishes. | `interrupt` (additive, not preemptive) |
| `interrupt` | Call `abort` RPC on target session → stops current execution immediately. | `sendToSession` (preemptive, not queued) |
| `grantAccess` | Call `permission` RPC on target session → resolves the pending approval Promise. | `sendToSession` (structured RPC, not free text) |
| `summarizeSession` | Fetch recent messages → call AI → return spoken summary. Also updates `sessions.summary_text`. | — |
| `spawnSession` | POST to Happy daemon's local HTTP port → insert new sessions row. | — |

### How `interrupt` and `grantAccess` call RPCs on other sessions

Both actions need to call an RPC method on a target session's socket — the same mechanism the mobile app uses (app socket → Happy server → session socket → `RpcHandlerManager`). Conductor cannot do this through its own session-scoped socket because:

- Conductor's socket is scoped to its own `sessionId` — the server routes events for that session only
- Opening a temporary session-scoped socket pretending to be the target session is semantically wrong and may be rejected server-side
- The `rpc-call` socket event is designed for user-level (non-session-scoped) clients, not peer sessions

**Decision: Option B — HTTP RPC endpoint on the Happy server**

Add a single endpoint to the Happy server:

```
POST /v1/sessions/:id/rpc/:method
Authorization: Bearer <token>
Body: { params: "<base64-encrypted-payload>" }
```

The server receives the request, finds the target session's live socket, emits `rpc-call`, and returns the result. Conductor encrypts `params` with the target session's key (stored in its SQLite DB) — the server passes it through without decrypting, preserving E2E encryption end-to-end.

**Why not Option A (temporary socket)?**
- May silently fail — `rpc-call` emission may be restricted to user-level clients server-side
- Abuses `session-scoped` clientType for a purpose it was not designed for
- A WebSocket connection per action is heavyweight and creates unpredictable state

**Why Option B?**
- Semantically correct: Conductor is an orchestrator calling into a session
- Stateless HTTP — one call per action, easy to debug, no connection lifecycle
- Authorization is explicit server-side (same user's sessions only)
- General-purpose: any future orchestrator can use the same endpoint
- **Required server change**: one new route in `packages/happy-server` (or equivalent). This is a prerequisite for `interrupt` and `grantAccess` to be implemented.

How each action uses it:

| Action | RPC method | Payload |
|---|---|---|
| `interrupt` | `abort` | `{}` (no params needed) |
| `grantAccess` | `permission` | `{ id: requestId, approved: boolean, decision: string }` |

---

## LLM's Role

LLM handles two things only:
1. **Fuzzy session identification** — "the schemahub one" → correct session ID from the DB list
2. **Summarization** — `summarizeSession` calls AI to produce a spoken-English summary

LLM does **not** handle:
- Action routing for unambiguous commands (list, spawn)
- State management

### LLM Input (prompt context)

```
System: You are Conductor, a local session manager for Claude Code.
  Given the active sessions and recent conversation, decide what to do.
  Reply ONLY with valid JSON matching the schema below.
  Never invent a session_id — only use IDs from the provided session list.

Active sessions:
  [{ id, directory, agentType, lifecycleState, summaryText }...]

Recent conversation (last 10 turns):
  [{ role: 'user'|'conductor', text }...]

User message: "<text>"
```

### LLM Output (Zod-validated)

```typescript
const LLMPlan = z.object({
  action: z.enum([
    'fetch_sessions',
    'send_to_session',
    'interrupt',
    'grant_access',
    'summarize_session',
    'spawn_session',
    'none',
  ]),
  session_id: z.string().nullable(),
  params:     z.record(z.unknown()).nullable(),  // action-specific payload
  reply:      z.string(),                        // spoken English back to user
});
```

If Zod validation fails → Conductor replies with a clarification request. No silent failures.

---

## SQLite Schema (Single Source of Truth)

SQLite replaces `conductor.state.json` entirely. On startup Conductor reads identity from the DB. On restart it recovers full state from the DB.

```sql
-- Conductor's own Happy session identity. Exactly one row.
CREATE TABLE IF NOT EXISTS conductor_identity (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  session_id         TEXT    NOT NULL,
  session_tag        TEXT    NOT NULL,
  encryption_key     TEXT    NOT NULL,   -- base64
  encryption_variant TEXT    NOT NULL,   -- 'legacy' | 'dataKey'
  seq                INTEGER NOT NULL DEFAULT 0,
  metadata_version   INTEGER NOT NULL DEFAULT 0,
  updated_at         INTEGER NOT NULL
);

-- Registry of all known sessions on this machine.
-- Encryption keys stored here so Conductor can send to any session.
CREATE TABLE IF NOT EXISTS sessions (
  id                 TEXT    PRIMARY KEY,
  directory          TEXT    NOT NULL,
  agent_type         TEXT    NOT NULL DEFAULT 'claude',
  lifecycle_state    TEXT    NOT NULL DEFAULT 'running',
  encryption_key     TEXT    NOT NULL,   -- base64
  encryption_variant TEXT    NOT NULL,
  seq                INTEGER NOT NULL DEFAULT 0,
  summary_text       TEXT,               -- last known summary (from metadata or summarizeSession)
  first_seen_at      INTEGER NOT NULL,
  last_seen_at       INTEGER NOT NULL,
  is_active          INTEGER NOT NULL DEFAULT 1   -- 0 = archived / gone from server
);

-- Rolling conversation window fed to LLM as context.
-- Pruned to last N rows on insert.
CREATE TABLE IF NOT EXISTS conversation (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  role                  TEXT    NOT NULL,   -- 'user' | 'conductor'
  text                  TEXT    NOT NULL,
  referenced_session_id TEXT,
  timestamp             INTEGER NOT NULL
);

-- Append-only action audit log.
CREATE TABLE IF NOT EXISTS action_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action_type TEXT    NOT NULL,
  session_id  TEXT,
  payload     TEXT,              -- JSON
  outcome     TEXT,              -- 'ok' | 'error: <message>'
  timestamp   INTEGER NOT NULL
);
```

---

## Module Structure

```
packages/conductor/src/
  db/
    schema.ts             — DDL strings + runMigrations()
    Database.ts           — typed wrapper over better-sqlite3

  actions/
    fetchSessions.ts      — GET /v1/sessions → decrypt → upsert sessions table
    sendToSession.ts      — encrypt + POST message → append action_log
    interrupt.ts          — POST /v1/sessions/:id/rpc/abort → append action_log [requires server endpoint]
    grantAccess.ts        — POST /v1/sessions/:id/rpc/permission → append action_log [requires server endpoint]
    summarizeSession.ts   — fetch messages + call AI → update summary_text
    spawnSession.ts       — POST to daemon → insert sessions row
    index.ts              — createActions(db, client): Actions

  LLMTranslator.ts        — build prompt → call AI → Zod-validated LLMPlan
  ConductorSession.ts     — Socket.IO for conductor's own session (receive / reply)
  HappyClient.ts          — REST + daemon HTTP client
  crypto.ts               — encrypt / decrypt utilities
  config.ts               — read ~/.happy/* config files
  types.ts                — shared TypeScript types
  index.ts                — startup: init DB → recover or create identity → wire triggers
```

### Startup / Recovery Flow

```
1. runMigrations(db)                          — ensure schema exists
2. identity = db.getConductorIdentity()
   if identity:
     verify session still exists on server
     if ok  → reconnect using stored key + seq
     if gone → create new session, db.upsertIdentity(...)
   else:
     create new session with UUID tag
     db.upsertIdentity(...)
3. conductorSession.connect()
4. conductorSession.onUserMessage(handler)    — the only trigger wired in Phase 1
```

---

## Trigger Wiring (index.ts)

```typescript
const db      = new Database(dbPath);
const client  = new HappyClient(serverUrl, credentials);
const actions = createActions(db, client);

conductorSession.onUserMessage(async (text, seq) => {
  const sessions     = db.getAllActiveSessions();
  const history      = db.getRecentConversation(10);
  const plan         = await llm.translate(text, sessions, history);

  if (plan.action !== 'none') {
    await actions[plan.action](plan.session_id, plan.params);
  }

  db.appendConversation('user',      text,       plan.session_id);
  db.appendConversation('conductor', plan.reply, plan.session_id);
  db.updateSeq(seq);

  await conductorSession.reply(plan.reply);
});

// Future triggers — wired here, actions unchanged:
// setInterval(() => actions.fetchSessions(), 30_000);
// conductorSession.onAppOpen(() => actions.fetchSessions());
```

---

## Session Key Discovery

Conductor can decrypt a session's metadata/messages only if it has the session's encryption key. Two sources:

1. **`~/.happy/sessions.json`** — written by `happy-cli` when it creates a session. Fastest path.
2. **`~/.happy/agent.key`** — if present, Conductor derives `contentKeyPair` and can unwrap `dataEncryptionKey` from the server response for any session.

If neither is available for a given session, that session is skipped during `fetchSessions`.

**Known gap**: sessions started before Conductor ran — or on machines that don't write to `sessions.json` — may not be decryptable without `agent.key`.

---

## Open Questions

### ~~OQ-1: `grantAccess` protocol~~ — RESOLVED

`grantAccess` calls the `permission` RPC on the target session via the new HTTP RPC endpoint (`POST /v1/sessions/:id/rpc/permission`). The session's existing `PermissionHandler` already listens for this RPC and resolves the pending approval Promise. Conductor reads pending permission requests from `agentState.requests` (already available in the `/v1/sessions` response) and surfaces them to the user.

### ~~OQ-2: `interrupt` implementation~~ — RESOLVED

`interrupt` calls the `abort` RPC on the target session via the HTTP RPC endpoint (`POST /v1/sessions/:id/rpc/abort`). The session's existing `claudeLocalLauncher` handler calls `doAbort()`, which stops current Claude execution cleanly and switches to remote mode. This is the same mechanism the mobile app's stop button uses. **Prerequisite**: the HTTP RPC endpoint must be added to the Happy server before either action can be implemented.

### OQ-3: Conversation pruning — when and how many turns?

The conversation table grows indefinitely. We need a cap (e.g. keep last 50 rows). Should pruning happen:
- On every `appendConversation` call (simple, inline)
- On a separate scheduled cleanup

### OQ-4: LLM model and cost

`summarizeSession` calls AI on every user request (if they ask for a summary). `LLMTranslator` calls AI on every user message for routing. 

Two options:
- **Same model for both** — simpler, one token budget
- **Fast/cheap model for routing** (Haiku), **capable model for summaries** (Sonnet/Opus) — lower cost per message but more config

### OQ-5: Multiple Conductor instances

If user runs Conductor on two machines, both create their own Happy sessions and both appear in the app. The app user sees "Conductor" twice. Is this acceptable, or do we need deduplication?

### OQ-6: Session key write-back

When `fetchSessions` encounters a session whose key it could decrypt (via `agent.key`), should it write that key back into the `sessions` table for future use? This would make subsequent calls faster and work even if `agent.key` is removed. Potential security concern: keys accumulate in the DB.
