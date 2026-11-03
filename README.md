# Huddle

A watch-party prototype for IPL T20 cricket, PKL kabaddi, ISL football and NBA basketball. Friends chat in a room while a game plays,
with the live scorecard above the chat. Tapping the scorecard opens the Match Centre: the full scorecard, graphs,
commentary and overs. The AI Co-host posts big moments and polls in the chat and answers questions nobody else
answered; the Dream Bot answers your own questions about the game, its rules and its players, privately.

The games are fixtures: real teams and players, scripted games. Nothing here is connected to Dream11 or to a live data
feed. Product rules: [CLAUDE.md](CLAUDE.md). Design: [docs/architecture.md](docs/architecture.md). Endpoints:
[docs/api-contract.md](docs/api-contract.md).

## Features

| Feature | Status |
|---|---|
| One-tap join: Huddle picks a username like @fan_4821, which you can change, along with the team and up to 3 players you back in each sport. No name, phone number or password; the browser stays signed in for 30 days | Implemented |
| One public watch party per sport (up to 100 members, moderated by Huddle) and private rooms (up to 50; the owner picks relaxed, balanced or strict moderation), with invitations, roles, leaving and removal | Implemented |
| Realtime chat (long-polling), reactions, polls, presence and replies; one message per person every 10 s across all rooms and devices | Implemented |
| A home screen card per sport, with the live game's score; the live scorecard above the chat; **Catch me up** (the match so far in stats and key moments, and what the room is saying on each #thread); and the Match Centre with swipeable tabs: Scorecard, Graphs (Manhattan and worm for cricket, score progression), Commentary, and Overs or Play by play | Implemented on fixture data |
| Big moments posted in the chat by the AI Co-host (deduplicated), each with its own #thread, plus a #thread for each topic the room argues about | Implemented on fixture data |
| A crowd of 200 scripted fans chatting in each public watch party, never stored; room settings can hide it | Fixture data |
| AI Co-host and Dream Bot: answers in the chat to questions nobody answered, polls on what the room is arguing about, and private answers and catch-ups in the Dream Bot window. Every number must come from verified match data, the rules sheet or the roster. A primary and a fallback provider sit behind a circuit breaker (Gemini, xAI Grok, Anthropic, OpenRouter) | Implemented; needs an API key (without one, the Dream Bot gives the latest score instead of an answer, and catch-ups come straight from match data) |
| A safety baseline at every moderation level, reports, a human review queue and appeals | Implemented |
| Messages disappear when a room ends and are deleted from the server after 24 h | Implemented |
| Real sports data feeds, account recovery, blocking | Planned |

## Run locally

Needs Node.js 22.18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000. Data lives in an embedded Postgres (PGlite) under `.data/`. To try a private room with a
friend on one machine, join from two browser profiles and invite one from the other by username.

Every room follows the game in progress for its sport, played at half speed (`DEMO_SPEED` changes the pace). The **+**
in a public watch party's watching strip starts a private room on the same game.

For the live AI Co-host and Dream Bot, set provider keys in `.env` locally, or in Vercel's environment variables:

```bash
GEMINI_API_KEY=...   # GEMINI_MODEL to change the model
XAI_API_KEY=...      # xAI Grok; XAI_MODEL to change the model (GROK_API_KEY also works)
```

With both, Gemini answers first and Grok takes over when Gemini fails. `AI_PRIMARY` and `AI_FALLBACK` choose among
`gemini`, `xai`, `anthropic` (`ANTHROPIC_API_KEY`) and `openrouter` (`OPENROUTER_API_KEY`). Moderators, who see the
review queue at `/mod`, are listed by account id in `MODERATOR_USER_IDS`; your id is in the app menu.

## Test

```bash
npm test            # 123 tests against the real API and an in-memory database
npm run typecheck   # strict TypeScript: server, tests and browser app
```

`node scripts/load-check.ts` runs a small load check (3 rooms of 10 members, a message burst and a slow AI provider)
and reports delivery latency, losses, duplicates and ordering.

## Deploy

On Vercel, `npm run build` compiles the browser code into `public/`, which is served as static files, and the API runs
as one function (`api/router.ts`). It needs `DATABASE_URL` (Neon Postgres) and `HUDDLE_SECRET`; joining fails closed
without the secret. Optional: AI keys, and `CRON_SECRET` for the daily sweep. Vercel runs no background worker, so
queued work runs inside members' long-polls.

On any other Node host with Postgres, `npm start` with `DATABASE_URL` set runs the worker in-process.

## Layout

| Path | Contents |
|---|---|
| `server.ts`, `api/router.ts` | Local server; Vercel function |
| `lib/http/`, `lib/auth/` | Router and routes; sessions |
| `lib/rooms/`, `lib/chat/` | Rooms, invitations, the per-room event log and long-polling; messages, reactions and polls |
| `lib/match/` | The four fixture games and their engines, feed ingestion, graphs, momentum rules, the scripted crowd |
| `lib/ai/`, `lib/cohost/` | AI providers and failover, task schemas and output validation; the AI Co-host and the Dream Bot |
| `lib/moderation/`, `lib/jobs/` | Safety checks and review; the job queue |
| `lib/db/` | Database access, row types and migrations |
| `web/` | Browser app, compiled into `public/watch/` by `npm run build` |
| `public/` | HTML, styles and images |
| `test/` | Tests (`node --test`) |

Team, driver and player names and logos belong to their owners and are used only to make the prototype feel real.
