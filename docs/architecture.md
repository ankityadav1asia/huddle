# Huddle Watch Party: architecture

Huddle is a cricket Watch Party prototype: friends (or the public) chat in a room while a match plays, the room
shows verified match data, and an AI Co-host answers questions, flags big moments and catches people up. It is one
Node.js application with one Postgres database. There is no video, no microservice split, no Redis and no broker.

**Status labels used below:** **Implemented** (built and covered by tests), **Simulated** (demo data, labelled in
the UI), **Planned** (not built).

| Capability | Status |
|---|---|
| Joining (guest profile: display name + @handle), sessions | Implemented. No phone number or password: a 30-day HttpOnly session cookie keeps the browser signed in; new profiles are limited per network |
| Public and private Watch Party rooms, invitations, roles, presence | Implemented; six labelled **demo friends** can be invited to try invitations alone |
| Realtime chat, reactions, polls (long-polling) | Implemented |
| Match Intelligence: scorecard, commentary, status, stats, freshness | Implemented on a **simulated** replay feed (real players, made-up match) |
| Match Momentum Engine (deterministic rules, dedup, fan-out) | Implemented |
| AI Co-host: Q&A, unanswered questions, quiet-room polls, momentum explanations, Catch Me Up | Implemented; live AI needs an API key (none was available while building, so provider calls are tested with mocked HTTP) |
| Primary/fallback AI providers, circuit breaker | Implemented (Anthropic, OpenRouter, Gemini adapters) |
| Moderation levels, public policy, mandatory baseline, reports, review queue, appeals | Implemented |
| In-app alerts; browser push for away members | In-app implemented; push implemented with VAPID and tested against a mocked push service |
| Ephemeral rooms (end, revoke, purge after retention) | Implemented |
| Real cricket data provider, account recovery, user blocking, quiet hours, async AI moderation | Planned |

## 1. System overview

```mermaid
flowchart LR
  subgraph Browser
    UI[Watch Party UI<br/>public/index.html + public/watch/*]
    SW[Service worker<br/>public/sw.js]
  end
  subgraph Server["Node server (server.js locally, api/router.js on Vercel)"]
    API[JSON API router<br/>lib/http]
    RT[Long-poll gateway<br/>lib/rooms/realtime.js]
    W[Worker: one job queue<br/>lib/jobs]
    FEED[Match feed ingestion<br/>lib/match]
    CO[AI Co-host orchestration<br/>lib/cohost + lib/ai]
    MOD[Moderation gate<br/>lib/moderation]
  end
  DB[(Postgres<br/>PGlite locally, Neon/any Postgres hosted)]
  P1[Primary AI provider]
  P2[Fallback AI provider]
  PUSH[Browser push services]
  UI -- "fetch + HttpOnly cookie" --> API
  UI -- "GET /events?after=seq&wait=1" --> RT
  API --> MOD
  API --> DB
  RT --> DB
  W --> DB
  W --> FEED
  W --> CO
  CO --> P1
  CO -. "only on timeout / 5xx / overload / 429" .-> P2
  W --> PUSH --> SW
```

- **One backend.** `server.js` serves the static UI, the API and runs the worker loop in-process. On Vercel the same
  router runs as one function (`api/router.js`), and long-poll requests run due jobs while they wait.
- **One database.** Postgres SQL everywhere. Locally the server embeds **PGlite** (Postgres compiled to WebAssembly),
  so `npm start` needs no setup. With `DATABASE_URL` set it uses node-postgres against any Postgres (e.g. Neon).
- **Realtime = long-polling.** Every visible change in a room gets the next per-room sequence number in `room_events`.
  Clients poll `GET /api/rooms/:id/events?after=<seq>&wait=1`; the server answers as soon as something newer exists
  (in-process wake-up locally, a 1-second database check across instances). Each poll re-authorises the caller, so
  leaving, removal and room closure cut the stream off immediately.
- **One job queue** (`jobs` table) for everything slow: AI answers, quiet-room checks, momentum explanations, polls
  closing, push delivery, room auto-end and purge. Chat delivery never waits for it.

## 2. Where the data lives

| Data | Where | Retention |
|---|---|---|
| All application data (tables in §3) | Local: `.data/pglite/` (embedded Postgres files, git-ignored). Hosted: the Postgres in `DATABASE_URL` | Per table, §3 |
| Server secret for HMACs | `HUDDLE_SECRET`; locally generated once into `.data/dev-secret` | Until rotated |
| Browser push keys (VAPID) | `VAPID_*` env; locally generated into `.data/vapid.json` | Until rotated |
| AI provider keys | Server environment only (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`). Never in the browser, logs or job payloads | n/a |
| Session | Browser: random token in an `HttpOnly; SameSite=Lax` cookie. Server: only its SHA-256 hash in `sessions` | 30 days |
| Push subscription | Browser push service + `push_subscriptions` (endpoint and keys) | Until removed or the endpoint returns 404/410 |
| Match feed | `match_events` / `match_signals`, shared by every room that follows the match | Kept with the match (demo data) |
| Data sent to AI providers | Per request only: verified match facts, a bounded window of this room's messages with members pseudonymised (`member1`…), the question. Never handles, phone numbers, other rooms or secrets | Subject to each provider's own terms |
| Logs | stdout JSON lines: ids, categories, timings. Message text, tokens and keys are redacted (`lib/log.js`) | Hosting log retention |
| Hosted database backups | The Postgres provider's backups / point-in-time restore | Follow the provider's window. Huddle's purge does not reach backups, so deletion there is not immediate |

## 3. Database schema

Defined in `lib/db/migrations/001_watch_party.sql` and applied automatically at start-up (additive migrations,
advisory-locked so two instances never race). IDs are prefixed random strings (`usr_…`, `room_…`, `msg_…`).

```mermaid
erDiagram
  users ||--o{ sessions : has
  users ||--o{ room_members : joins
  users ||--o{ room_invitations : "invites / is invited"
  users ||--o{ push_subscriptions : registers
  users ||--|| notification_prefs : sets
  matches ||--o{ match_events : "feed (shared)"
  matches ||--o{ match_signals : "momentum rules"
  match_events ||--o{ match_signals : evidence
  matches ||--o{ rooms : "followed by"
  rooms ||--o{ room_members : has
  rooms ||--o{ room_invitations : has
  rooms ||--o{ room_events : "ordered log"
  rooms ||--o{ messages : contains
  rooms ||--o{ polls : contains
  rooms ||--o{ room_insights : "in-app alerts"
  match_signals ||--o{ room_insights : "fanned out to"
  messages ||--o{ message_reactions : has
  polls ||--o{ poll_votes : has
  rooms ||--o{ jobs : "room-scoped work"
  rooms ||--o{ reports : has
```

### Identity and access
| Table | Purpose | Key columns |
|---|---|---|
| `users` | One row per profile | `handle` (unique, public), `display_name`, `team`; `is_demo` (the labelled demo friends, migration `005`); `phone_e164` (nullable, unused since phone sign-in was removed in migration `004`) |
| `sessions` | Server-side sessions | `token_hash` (SHA-256 of the cookie token), `expires_at`, `revoked_at` |

### Match Intelligence (shared across rooms; never per room)
| Table | Purpose | Key columns |
|---|---|---|
| `matches` | One match run | `source` = `demo_fixture`, `status` scheduled/live/completed, `feed_started_at`, `ball_interval_ms`, `backfill_until` (demo jumps) |
| `match_events` | Timestamped feed events | `provider_event_id` (unique per match: dedupes re-ingestion), `seq`, `kind` ball/event/overend, `data` (bowler, batter, runs, wicket…), `occurred_at`, `backfilled` |
| `match_signals` | Momentum Engine output, one per crucial moment | `trigger` (e.g. `wicket_fallen`), `priority` high/medium/low, `evidence` (verified facts), `fact_text` (deterministic sentence), `dedupe_key` (unique), `status` pending/published/suppressed/expired, `ai_text` (optional validated explanation), `expires_at` |

The scorecard (runs, wickets, overs, required rate, batting and bowling cards, fall of wickets, partnership) is not
stored: it is recomputed deterministically from `match_events` and cached in memory per match.

### Rooms and membership
| Table | Purpose | Key columns |
|---|---|---|
| `rooms` | Watch parties | `room_type` public/private, `creator_id` (required for private), `match_id`, `moderation_level` (private only; a CHECK forbids storing one on public rooms), `status` active/ended/purged, `last_seq` (per-room sequence), `ai_enabled`, `ended_at`, `purge_after` |
| `room_members` | Membership and roles | PK `(room_id, user_id)`, `role` owner/admin/member (at most one owner per room, unique index), `status` active/left/removed |
| `room_invitations` | Invitations | `inviter_id`, `invitee_id`, `status` pending/accepted/declined/expired/revoked, `expires_at` (48 h); at most one pending invite per person per room |
| `room_presence` | Who is in the room now | `last_seen_at` (refreshed by polls), `state` active/inactive (tab visible or hidden) |

### Room content: ephemeral
| Table | Purpose | Key columns |
|---|---|---|
| `room_events` | Realtime outbox: what changed, in order | PK `(room_id, seq)`, `type` message/message_update/poll/insight/member/room, `entity_id`. Ids only, no text |
| `messages` | Chat and AI Co-host replies | `sender_type` user/ai (AI messages have no sender and a distinct type so the AI can never trigger itself), `client_msg_id` (idempotency key, unique per sender), `body`, `reply_to_id`, `status` visible/held/removed, `answer_state` (pending → human / ai_claimed → ai_answered / ai_unavailable / cancelled), `ai_meta` (provider, model, grounding; never the prompt), `moderation` (decision summary; never a copy of the text) |
| `message_reactions` | Allowlisted emoji reactions | PK `(message_id, user_id, emoji)` |
| `polls`, `poll_votes` | AI or template polls | `idempotency_key` (unique), one open poll per room, `closes_at` |
| `room_insights` | In-app delivery of a match signal to one room | unique `(room_id, signal_id)`: a retry can never show the same alert twice |

When a room ends, every user-facing read of this content stops at once. The purge job deletes all of it
`MESSAGE_RETENTION_HOURS` later (default 24 h) and nulls the room name; a sweep re-queues any purge that was missed.

### Limits
| Table | Purpose |
|---|---|
| `user_send_cooldowns` | One row per user: `next_allowed_at`. The 30-second chat rule is one atomic `INSERT … ON CONFLICT DO UPDATE … WHERE next_allowed_at <= now()` |
| `rate_events` | Sliding-window counters for new profiles per network, AI requests, reactions and search (advisory-locked per bucket). Deleted after 2 h |

### Moderation (minimal audit, no message text)
| Table | Purpose |
|---|---|
| `moderation_events` | Every automated or human decision: categories, severity, `policy_version`, level, action. Retained 30 days |
| `reports` | Member reports (message or AI response) and appeals; status open/dismissed/actioned |

### Background work, AI observability, notifications
| Table | Purpose |
|---|---|
| `jobs` | The one queue: `type`, `room_id`, `dedupe_key` (unique), `payload` (ids and deadlines only), `priority`, `status` queued/running/done/dead/cancelled, `run_at`, `expires_at`, `attempts`/`max_attempts`, `locked_until` |
| `ai_calls` | One row per provider attempt: task, provider, model, outcome, error category, fallback reason, latency, tokens. No prompts or transcripts. Retained 7 days |
| `notification_prefs` | Per-user push choices (momentum on, answers off, invites on by default) |
| `push_subscriptions` | Browser push endpoints and keys |
| `notification_deliveries` | Delivery metadata only: `dedupe_key` (source event + recipient), kind, priority, status, `expires_at`. No notification text, no inbox. Deleted after 24 h |

## 4. Workflows

### 4.1 Joining
1. A new visitor picks a display name, an @handle and optionally a team: `POST /api/auth/guest`. Names and handles
   pass the same strict safety check as other public labels, handles are unique, and reserved handles (huddle,
   admin, moderator…) are refused.
2. The server creates the profile and a session. The browser holds a random token in an HttpOnly, SameSite=Lax
   cookie (`__Host-` prefixed and Secure in production); the database keeps only its SHA-256 hash. Sessions last
   30 days. There is no password, so a profile cannot be recovered after signing out or clearing the browser.
3. New profiles are limited per network (`GUEST_SIGNUPS_PER_IP_PER_HOUR`, default 10), so nobody can mint accounts
   to get around the one-message-every-30-seconds rule. Without `HUDDLE_SECRET` joining fails closed.
4. Platform moderators are listed by account id (`MODERATOR_USER_IDS`). Ids are random and server-generated, so
   nobody can claim moderator rights by choosing a name.

### 4.2 Private room and invitations
`POST /api/rooms` creates the room, makes the caller its owner, records the chosen level (`relaxed`/`balanced`/`strict`)
and invites up to 10 people found through handle search (never phone search). Invitees see the invitation on their home
screen (and as a generic push if they opted in). Accepting checks that the invitation belongs to the caller, is still
pending, unexpired, the room is active and not full. Owners promote members to admin; nobody can change their own role.

To try invitations without a second person, six demo friends are created once, the first time anyone loads
`GET /api/rooms`: handles `demo_aarav`, `demo_diya`, `demo_kabir`, `demo_meera`, `demo_rohan` and `demo_sana`, names
ending in "(demo)", `users.is_demo = true`. The invite picker offers them while its search box is empty
(`GET /api/users/demo`) and search marks them `demo: true`. They never get a session and nobody can join with a
`demo_` handle, so their invitations stay pending until revoked or expired. `DEMO_USERS=false` stops offering them.

### 4.3 Sending a message (fast path)
```mermaid
sequenceDiagram
  participant C as Client
  participant API as API
  participant DB as Postgres
  participant O as Other members (long-poll)
  C->>API: POST /rooms/:id/messages {client_msg_id, text}
  API->>DB: session, membership, room active
  API->>DB: same client_msg_id already stored? return it
  API->>API: safety gate (lib/moderation/classifier.js)
  alt rejected
    API-->>C: 422 + reason (no row, no cooldown used, audit row only)
  else allowed / flagged / held
    API->>DB: BEGIN; 30 s limiter CAS; next room seq; insert message; room_events; follow-up jobs; COMMIT
    API-->>C: 201 message + cooldown_until
    DB-->>O: next poll (or in-process wake-up) returns the event
  end
```
Held messages (uncertain high-risk text) are stored without a sequence number and are visible only to the sender and
moderators until reviewed. AI work is only queued here: no LLM call ever sits on this path.

### 4.4 Match Momentum
1. The worker advances every live match feed once per tick. Due items are inserted into `match_events` (deduped by
   provider event id) inside a per-match row lock.
2. The deterministic rules in `lib/match/momentum.js` compare the scorecard before and after each item: wickets
   (`partnership_break` when a 30+ stand ends), dropped catches, boundary bursts, dot-ball pressure, a required-rate
   spike, death overs, DRS outcomes and the confirmed result. Thresholds are documented demo heuristics.
3. Only fresh signals alert. A backlog (server asleep), a demo jump (backfill) or several signals in one pass publish
   at most one alert; the rest are stored as `suppressed` for Catch Me Up.
4. A `momentum_signal` job asks the AI Co-host for one explanatory sentence, validates it (schema, cited event ids,
   every number must exist in the verified data, strict safety), and publishes with a compare-and-set. Without AI, the
   deterministic `fact_text` is published on its own.
5. Fan-out: one `room_insights` row per active room following the match → every eligible member sees it in the room
   feed; high and medium priority also show as an in-app toast.
6. Notifications: high and medium priority moments (wickets, partnership breaks, dropped catches, run-rate spikes,
   the result) go to opted-in members with a push subscription who are **not looking at the room** (tab hidden or
   closed; people watching the room get the in-app pop-up instead). Each person gets at most
   `MATCH_ALERTS_PER_USER` (default 8) per match, at least 90 s apart, with the last slot kept for the result.
   Low-priority moments (boundary bursts, dot balls, death overs, DRS) stay in-app only. Deliveries are deduped per
   signal and person; just before sending, the job re-checks room, membership, preference, expiry and whether the
   person has come back. The payload is verified match facts only: no room name, no chat text.

### 4.5 AI Co-host answers
- `@huddle …` queues an `ai_answer` job immediately. A cricket question without a mention queues one with a delay
  (`UNANSWERED_QUESTION_DELAY_SECONDS`, default 25 s).
- A human reply (`reply_to`, or an `@handle` mention of the asker) flips the question's `answer_state` from `pending`
  to `human`. The job claims the question with the same compare-and-set (`pending` → `ai_claimed`), so only one path
  can win.
- The job builds the context on the server: verified facts and commentary with timestamps, plus the last 12 messages
  of that room only, pseudonymised and labelled untrusted. It calls the orchestrator, validates the output, then
  publishes in a transaction that requires the room to still be active. An answer that fails validation, or a room
  that ended mid-generation, publishes nothing.

### 4.6 Catch Me Up
`POST /api/rooms/:id/catchup {since_seq}` checks membership and room state, gathers this room's messages since that
point (max 40), the match events and key moments since then, and polls. It returns either an AI summary (validated) or a
deterministic summary from verified data. It goes to the requester only; nothing is written to the chat.

### 4.7 Quiet rooms
Each human message reschedules a `continuity_check` job for the room 3 minutes later. If the room is still quiet,
someone is online, the match is live and no poll was posted in the last 10 minutes, the Co-host posts one light poll
(AI, or a deterministic "Who wins from here?" template when no AI is configured).

### 4.8 Room end and purge
```mermaid
sequenceDiagram
  participant Owner
  participant API
  participant DB
  Owner->>API: POST /rooms/:id/end (owner; moderators for public rooms; or match finished + 10 min)
  API->>DB: UPDATE rooms SET status='ended' WHERE status='active' (atomic)
  API->>DB: cancel room jobs, expire invites and queued alerts, clear presence, queue purge at +24 h
  API->>API: clear room-scoped AI context cache, wake pollers (they get status 'ended', no history)
  Note over DB: 24 h later
  DB->>DB: room_purge job deletes messages, reactions, polls, insights, room_events; room.status='purged', name=NULL
```

### 4.9 AI provider failover
`lib/ai/orchestrator.js` runs every task with one overall deadline (16 s; 8–14 s for momentum and catch-up):
- Primary first. Retryable failures are timeout, 5xx, overload and 429. A 5xx, or a 429 with a short `Retry-After`,
  gets one retry; then the fallback is tried within the remaining deadline.
- Safety refusals, invalid requests, auth errors, malformed output and validation failures never switch providers.
- A per-provider circuit breaker opens after 3 consecutive failures for 30 s, then lets a single probe through.
- Concurrency is capped (3), and per-user (6 per 5 min) and per-room (30 per 10 min) AI budgets apply.
- If both providers fail, the Co-host degrades: chat, reactions, polls and match data keep working.

## 5. Security and privacy controls
- **Authorization on every request**: the user comes from the session; room access is checked in one place
  (`roomAccess`). Private rooms return 404 to non-members, the same answer as a missing room. Room type, roles and
  moderation level are read from the database, never from the request; unknown request fields are rejected.
- **Room isolation**: every query is scoped by room id after the membership check. AI context and caches are keyed by
  room and cleared when the room ends.
- **Prompt injection**: system instructions are server-owned; room text, names and commentary travel as labelled JSON
  data. The model has no tools, so it cannot read other rooms, change settings or act on anyone.
- **Input**: text only (multipart and attachments are refused with 415/400), 500-character limit, Unicode
  normalisation, invisible and bidi characters stripped, rendered with `textContent` only. CSP is `script-src 'self'`.
- **Moderation**: the baseline (threats, self-harm encouragement, hate slurs, sexual harassment, personal data) is
  enforced at every level and in every room type. Levels only tune profanity, insults and spam. Three stopped
  messages within ten minutes pause posting for two minutes; nobody is banned automatically. Members can report,
  three reports hide a message for human review, and appeals are possible.
- **Secrets** stay in server env vars; logs are redacted; `ai_calls` stores no prompts.
- **Transport and headers**: in production the session cookie is `__Host-` prefixed (Secure, host-only), HSTS is on,
  and the CSP allows scripts, connections and frames from this site only.
- **Room size**: public watch parties hold up to `PUBLIC_ROOM_MAX_MEMBERS` (100); private rooms up to 50 with invites.

## 6. Reliability guarantees (and what is not promised)
- Chat ordering: a concurrency-safe per-room sequence (`UPDATE rooms SET last_seq = last_seq + 1 … RETURNING`).
- Delivery: at-least-once; clients dedupe by sequence and entity id. No exactly-once promise.
- Idempotency: `client_msg_id` for messages, unique `dedupe_key` for jobs, signals and deliveries, unique
  `(room_id, signal_id)` for insights, a derived key for AI answers, and `idempotency_key` for polls.
- Jobs: durable (same transaction as the triggering write), retried with exponential backoff and jitter, dead-lettered
  after `max_attempts`, re-check room and membership when they run, and expire instead of delivering late.
- Measured with `node scripts/load-check.mjs` on one laptop (single server, embedded PGlite, 3 rooms × 10 members,
  everyone long-polling): a burst of 30 simultaneous messages reached all 270 recipients with no loss, duplicates or
  reordering, p95 send-to-delivery 0.85 s (the embedded database runs queries one at a time, so bursts queue).
  Messages sent while three 4-second AI calls were in flight arrived in p95 0.27 s, so slow AI work does not hold up
  chat. These are prototype numbers from one machine, not capacity claims; nothing was designed for large-scale traffic.

## 7. Known limitations
- The match feed is a scripted replay labelled as simulated. A licensed provider would replace `lib/match/fixture.js`.
- Joining is a guest profile without phone verification: one person can hold several profiles (limited per
  network per hour), and a profile cannot be recovered once its browser session is gone.
- Authorization is enforced in application code, not Postgres Row Level Security (one server role connects).
- On serverless hosting, background jobs run while some member is connected (long-poll requests drive them), plus
  a daily Vercel Cron sweep. A dedicated worker process would remove that dependency.
- Circuit-breaker state and the AI concurrency cap are per server instance.
- Live AI providers were not exercised end to end in this environment (no API keys); adapters are tested with mocked
  HTTP and the SDK's typed errors.
- Browser push was exercised with a mocked push service, not on a real device.
