# Huddle: Watch Party with an AI Co-host

A prototype of a cricket Watch Party: friends join a private room (or the public one), chat while the match plays, see
verified match data without leaving the room, and get help from an AI Co-host that answers questions, flags the big
moments and catches you up when you look away.

It grew out of the original single-viewer replay demo (still available at `/replay`). The product rules this build
follows are in [CLAUDE.md](CLAUDE.md); the design is in [docs/architecture.md](docs/architecture.md) and the endpoints
in [docs/api-contract.md](docs/api-contract.md).

## What works, and what is simulated

| | Status |
|---|---|
| Join with a display name and @handle (no phone number or password; the browser stays signed in for 30 days) | **Implemented** |
| Public watch party (up to 100 members, moderation run by Huddle) and private rooms (up to 50, owner picks relaxed / balanced / strict) | **Implemented** |
| Invite several friends, accept/decline/revoke, expiry, owner and admin roles, leave, remove | **Implemented** |
| Realtime chat, reactions, polls, presence, reply threads | **Implemented** (long-polling) |
| One message per person every 30 s, across every room, tab and device | **Implemented** (atomic, server-side) |
| Match Intelligence: score, overs, batting and bowling cards, fall of wickets, commentary, freshness | **Implemented** on a **simulated** MI v CSK replay (real players, made-up match) |
| Match Momentum: wickets, dropped catches, run-rate pressure, boundary bursts, result → one alert for everyone in the room | **Implemented** (deterministic rules, deduplicated) |
| AI Co-host: `@huddle` answers, answers to questions nobody answered, quiet-room polls, Catch Me Up | **Implemented**. Needs an AI key for live answers; without one, alerts and Catch Me Up fall back to summaries built from verified match data |
| Primary + fallback AI provider with circuit breaker | **Implemented** (Anthropic, OpenRouter, Gemini) |
| Notifications for big moments when you are not looking at the room (at most 8 per match, the last kept for the result), invitation alerts | **Implemented**, tested with a mocked push service |
| Mandatory safety baseline, reports, human review queue, appeals | **Implemented** |
| Messages vanish when the room ends; deleted from the server after 24 h | **Implemented** |
| Real cricket data feed, account recovery, user blocking, quiet hours | **Planned** |

Nothing here is connected to Dream11 systems or to a live match.

## Run it

Needs Node.js 22.13 or newer (tested on 24).

```bash
npm install
npm start
```

Open http://localhost:3000. Everything runs locally with no accounts: an embedded Postgres (PGlite) stores data in
`.data/` (git-ignored). To try a watch party with friends on one machine, sign in as different people in two browser
profiles (or one normal and one private window).

To try invitations on your own, invite the demo friends the invite picker offers while its search box is empty
(`@demo_aarav`, `@demo_diya`, `@demo_kabir`, `@demo_meera`, `@demo_rohan`, `@demo_sana`). They are labelled profiles
that nobody signs in as, so their invitations stay pending. `DEMO_USERS=false` hides them.

The demo match starts when someone joins a room for it and plays a ball roughly every 10 seconds. With
`DEMO_CONTROLS` on (the local default) the room's side panel can jump the replay to the bowling change, the DRS call,
the dropped catch or the last over.

To turn on the live AI Co-host, copy `.env.example` to `.env` and set one or two keys:

```bash
ANTHROPIC_API_KEY=...      # primary (claude-opus-5-5 at low effort by default)
GEMINI_API_KEY=...         # fallback
```

Choose the order with `AI_PRIMARY` / `AI_FALLBACK`. Keys stay on the server. Moderators (who see the review queue at
`/mod`) are listed by account id in `MODERATOR_USER_IDS` (your id is shown in the app menu).

## Test

```bash
npm test
```

82 tests (about 20 s) cover joining, room access and isolation, invitations and roles (including the demo friends),
the 30-second rule (including concurrent sends and the exact boundary), moderation levels and the baseline, the match
feed and momentum alerts, alert fan-out and push eligibility, AI failover and circuit breaking, the Co-host's race
with human replies, room closure and purge, observability, and log privacy.

`node scripts/load-check.mjs` runs a small load check: 3 rooms of 10 members, a burst of 30 messages and a slow AI
provider, reporting delivery latency, losses, duplicates and ordering.

## Deploy

Production on Vercel uses Neon Postgres (`DATABASE_URL`, added by the Vercel Marketplace integration), generated
`HUDDLE_SECRET` / `CRON_SECRET` / `VAPID_*` values. Visitors join with a name and handle; without `HUDDLE_SECRET`
joining fails closed.


The app is one server plus one Postgres database.

- **Vercel**: `vercel.json` serves `public/`, runs the API as one function (`api/router.js`) and keeps `api/ai.js`
  for the replay. It needs a Postgres `DATABASE_URL` (for example Neon from the Vercel Marketplace) and
  `HUDDLE_SECRET`. Optional: AI keys, `VAPID_*` for push, `CRON_SECRET` for the daily sweep. Serverless functions do not
  run a background worker, so queued work runs while members are connected (their long-polls drive it).
- **Any Node host with Postgres**: `npm start` with `DATABASE_URL` set runs the worker in-process.

## Files

| Path | What |
|---|---|
| `server.js` | Local server: static files, API, replay endpoint, background worker |
| `api/router.js`, `api/ai.js` | Vercel functions (Watch Party API, original replay AI endpoint) |
| `lib/http/` | Router and routes |
| `lib/auth/` | Sessions (HttpOnly cookie, server-side hashes) |
| `lib/rooms/` | Rooms, membership, invitations, the per-room event log, long-polling, lifecycle and purge |
| `lib/chat/` | Message fast path, reactions, polls, rendering |
| `lib/moderation/` | Safety gate, lexicon, policy, audit, reports and review |
| `lib/match/` | Simulated feed, scorecard, momentum rules, ingestion |
| `lib/ai/`, `lib/cohost/` | Provider adapters, failover orchestrator, task schemas and validation, Co-host behaviours |
| `lib/notify/` | Notification policy, push delivery |
| `lib/jobs/` | The job queue, worker, housekeeping |
| `lib/db/` | Database access and migrations |
| `public/index.html`, `public/watch/` | Watch Party UI |
| `public/replay.html`, `public/src/` | The original single-viewer replay demo |
| `test/` | Automated tests (`node --test`) |

Team names and logos belong to their franchises and are used only to make the prototype feel real.
