# Huddle

A watch-party prototype for cricket, Formula 1, basketball and ice hockey. Friends chat in a room while a game plays,
see verified match data next to the chat, and can ask an AI co-host (`@huddle`) about the game, its rules and its
players.

Every game is a simulated replay: real teams and players, made-up games. Nothing here is connected to Dream11 or to a
live match. Product rules: [CLAUDE.md](CLAUDE.md). Design: [docs/architecture.md](docs/architecture.md). Endpoints:
[docs/api-contract.md](docs/api-contract.md).

## Features

| Feature | Status |
|---|---|
| Guest profiles: display name, @handle, and the team and up to 3 players you back in each sport. No phone number or password; the browser stays signed in for 30 days | Implemented |
| One public watch party per sport (up to 100 members, moderated by Huddle) and private rooms (up to 50; the owner picks relaxed, balanced or strict moderation), with invitations, roles, leaving and removal | Implemented |
| Realtime chat (long-polling), reactions, polls, presence and replies; one message per person every 10 s across all rooms and devices | Implemented |
| A scoreboard for each sport, play by play, and big-moment alerts (deduplicated; at most 8 pushes per match) | Implemented on simulated games |
| A private room's own replay: start, pause, 0.5x/1x/2x, restart, jump to a big moment | Implemented |
| Moment threads: a #thread for each big moment and for each topic the room argues about | Implemented |
| 200 simulated fans in each public watch party, labelled and never stored | Simulated |
| AI co-host: answers, catch-up summaries and polls, stated only from verified match data, the rules sheet and the roster; a primary and a fallback provider behind a circuit breaker (Gemini, xAI Grok, Anthropic, OpenRouter) | Implemented; needs an API key (without one, summaries come straight from match data) |
| A safety baseline at every moderation level, reports, a human review queue and appeals | Implemented |
| Messages disappear when a room ends and are deleted from the server after 24 h | Implemented |
| Real sports data feeds, account recovery, blocking, quiet hours | Planned |

## Run locally

Needs Node.js 22.18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000. Data lives in an embedded Postgres (PGlite) under `.data/`. To try a room with friends on
one machine, sign in from two browser profiles, or invite the demo friends the invite picker offers (`@demo_aarav`,
`@demo_diya` and others; their invitations stay pending, and `DEMO_USERS=false` hides them).

Public watch parties follow a shared game that nobody can pause, at half speed (`DEMO_SPEED`). **+ Private room** in a
public watch party starts a private room on the same game; tick **Control the replay yourself** to run its replay.

For the live AI co-host, set provider keys in `.env` locally, or in Vercel's environment variables:

```bash
GEMINI_API_KEY=...   # GEMINI_MODEL to change the model
XAI_API_KEY=...      # xAI Grok; XAI_MODEL to change the model (GROK_API_KEY also works)
```

With both, Gemini answers first and Grok takes over when Gemini fails. `AI_PRIMARY` and `AI_FALLBACK` choose among
`gemini`, `xai`, `anthropic` (`ANTHROPIC_API_KEY`) and `openrouter` (`OPENROUTER_API_KEY`). Moderators, who see the
review queue at `/mod`, are listed by account id in `MODERATOR_USER_IDS`; your id is in the app menu.

## Test

```bash
npm test            # 119 tests against the real API and an in-memory database
npm run typecheck   # strict TypeScript: server, tests, browser app and service worker
```

`node scripts/load-check.ts` runs a small load check (3 rooms of 10 members, a message burst and a slow AI provider)
and reports delivery latency, losses, duplicates and ordering.

## Deploy

On Vercel, `npm run build` compiles the browser code into `public/`, which is served as static files, and the API runs
as one function (`api/router.ts`). It needs `DATABASE_URL` (Neon Postgres) and `HUDDLE_SECRET`; joining fails closed
without the secret. Optional: AI keys, `VAPID_*` for push, and `CRON_SECRET` for the daily sweep. Vercel runs no
background worker, so queued work runs inside members' long-polls.

On any other Node host with Postgres, `npm start` with `DATABASE_URL` set runs the worker in-process.

## Layout

| Path | Contents |
|---|---|
| `server.ts`, `api/router.ts` | Local server; Vercel function |
| `lib/http/`, `lib/auth/` | Router and routes; sessions |
| `lib/rooms/`, `lib/chat/` | Rooms, invitations, the per-room event log and long-polling; messages, reactions and polls |
| `lib/match/` | The four simulated games and their engines, feed ingestion, momentum rules, simulated fans, room replays |
| `lib/ai/`, `lib/cohost/` | AI providers and failover, task schemas and output validation; co-host behaviours |
| `lib/moderation/`, `lib/notify/`, `lib/jobs/` | Safety checks and review; push notifications; the job queue |
| `lib/db/` | Database access, row types and migrations |
| `web/` | Browser app and service worker, compiled into `public/` by `npm run build` |
| `public/` | HTML, styles and images |
| `test/` | Tests (`node --test`) |

Team, driver and player names and logos belong to their owners and are used only to make the prototype feel real.
