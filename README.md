# Huddle: Watch Party with an AI Co-host

A prototype of a sports Watch Party for cricket, Formula 1, basketball and ice hockey: friends join a private room (or
the public one for their sport), chat while the game plays, see verified match data without leaving the room, and get
help from an AI Co-host that answers questions (about the rules and the players too), flags the big moments and
catches you up when you look away.

It grew out of a single-viewer replay demo. That page is gone (`/replay` now opens the app) and its simulated replay
runs inside the watch party. The product rules this build follows are in [CLAUDE.md](CLAUDE.md); the design is in
[docs/architecture.md](docs/architecture.md) and the endpoints in [docs/api-contract.md](docs/api-contract.md).

## What works, and what is simulated

| | Status |
|---|---|
| Join with a display name and @handle, the team you back and up to 3 players (no phone number or password; the browser stays signed in for 30 days) | **Implemented** |
| One public watch party per sport (up to 100 members, moderation run by Huddle) and private rooms (up to 50, owner picks relaxed / balanced / strict) | **Implemented** |
| **+ Private room** in a public watch party: a private room on the same game in one tap, inviting friends by username | **Implemented** |
| Invite several friends, accept/decline/revoke, expiry, owner and admin roles, leave, remove | **Implemented** |
| Realtime chat, reactions, polls, presence, reply threads | **Implemented** (long-polling) |
| One message per person every 10 s, across every room, tab and device | **Implemented** (atomic, server-side) |
| Match Intelligence: a scoreboard for each sport (cricket scorecard, F1 running order and gaps, basketball and hockey score and clock), play by play, freshness | **Implemented** on **simulated** games: MI v CSK (T20), the Italian Grand Prix (last 13 laps), Warriors v Lakers (last 6 minutes), Oilers v Maple Leafs (third period). Real names, made-up games |
| Demo pace: every game plays at 0.5x by default (`DEMO_SPEED`) | **Implemented** |
| A private room's own replay: start, pause, 0.5x / 1x / 2x, restart, jump to a big moment (only that room moves) | **Implemented** (simulated replay only) |
| Moment threads: a #thread for each big moment (wickets, DRS, safety car, lead changes, clutch time, power-play goals, the result…) and for each topic three people argue about; chips above the chat filter it, replies stay in the thread | **Implemented** (deterministic, no AI needed) |
| Simulated fans: 200 per sport, chatting in that sport's public watch party only (private rooms hold only the people invited), labelled, the same for everyone in the room, hidable per device. The header counts real people online and the simulated fans separately | **Simulated** (demo data; never stored or sent to the AI) |
| Match Momentum: wickets, dropped catches, run-rate pressure, boundary bursts (cricket); pit stops, safety car, lead changes (F1); lead changes, clutch time, buzzer-beater (basketball); power plays, goals, empty net (hockey) → one alert for everyone in the room | **Implemented** (deterministic rules and scripted signals, deduplicated) |
| AI Co-host: `@huddle` answers, answers to questions nobody answered, quiet-room polls, Catch Me Up | **Implemented**. Needs an AI key for live answers; without one, alerts and Catch Me Up fall back to summaries built from verified match data |
| Rules and players help: each room shows newcomers what they can ask; a question about a rule or a player is answered from the sport's checked rules sheet and roster and the game as it stood when it was asked. Numbers found in none of those are rejected | **Implemented** (needs an AI key; the rules sheets are hand-written demo data) |
| Primary + fallback AI provider with circuit breaker | **Implemented** (Gemini, xAI Grok, Anthropic, OpenRouter) |
| Notifications for big moments when you are not looking at the room (at most 8 per match, the last kept for the result), invitation alerts | **Implemented**, tested with a mocked push service |
| Mandatory safety baseline, reports, human review queue, appeals | **Implemented** |
| Messages vanish when the room ends; deleted from the server after 24 h | **Implemented** |
| Real sports data feeds, account recovery, user blocking, quiet hours | **Planned** |

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

The home screen offers one public watch party per sport. Each follows a shared simulated game: it starts when someone
joins, plays at half speed (a ball, lap or play roughly every 20 seconds; `DEMO_SPEED=1` doubles it), and nobody can
pause or move it. Its 200 simulated fans chat there, never in private rooms.

**+ Private room** in a public watch party starts a private room on the same game in one tap: it is named after you
and you invite friends by username. To drive the simulation yourself, tick **Control the replay yourself** there (or
when you create a room from the home screen, where it is ticked by default). The room gets its own copy, and its owner
and admins can start it, pause it, play it at 0.5x, 1x or 2x, restart it or jump to its big moments (in cricket: the
bowling change, the DRS call, the dropped catch or the last over), from the bar under the score or the match panel.
Only that room moves. With `DEMO_CONTROLS` on (the local default) the shared replay can be jumped too, from its match
panel.

New to a sport? Every room shows example questions. Ask `@huddle` (or just ask, for example "What is icing?"): the
Co-host answers from the sport's checked rules sheet and roster and from the game as it stood when you asked, and says
which moment that was.

To turn on the live AI Co-host, set one or two provider keys: in a `.env` file locally, or under Environment
Variables on Vercel (as Secrets, then redeploy):

```bash
GEMINI_API_KEY=...         # Google Gemini (gemini-3.5-flash-lite by default; GEMINI_MODEL to change)
XAI_API_KEY=...            # xAI Grok (grok-4.20-0309-non-reasoning by default; XAI_MODEL; GROK_API_KEY also works)
```

With both, Gemini answers first and Grok takes over when Gemini fails; `AI_PRIMARY=xai` swaps them. Anthropic
(`ANTHROPIC_API_KEY`) and OpenRouter (`OPENROUTER_API_KEY`) are supported too; `AI_PRIMARY` / `AI_FALLBACK` pick any
two. Keys stay on the server. Moderators (who see the review queue at
`/mod`) are listed by account id in `MODERATOR_USER_IDS` (your id is shown in the app menu).

## Test

```bash
npm test
```

116 tests (under a minute) cover joining and player picks, room access and isolation, invitations and roles (including
the demo friends), the 10-second message rule (including concurrent sends and the exact boundary), moderation levels
and the baseline, the match feed and how fast it reaches the room, the four sports' games and their final scores,
private rooms' own replays and their controls, simulated fans (public rooms only), moment threads, momentum alerts,
rules questions answered at the moment they were asked, alert fan-out and push eligibility, AI failover and circuit
breaking, the Co-host's race with human replies, room closure and purge, observability, and log privacy.

`node scripts/load-check.mjs` runs a small load check: 3 rooms of 10 members, a burst of 30 messages and a slow AI
provider, reporting delivery latency, losses, duplicates and ordering.

## Deploy

Production on Vercel uses Neon Postgres (`DATABASE_URL`, added by the Vercel Marketplace integration), generated
`HUDDLE_SECRET` / `CRON_SECRET` / `VAPID_*` values. Visitors join with a name and handle; without `HUDDLE_SECRET`
joining fails closed.


The app is one server plus one Postgres database.

- **Vercel**: `vercel.json` serves `public/`, runs the API as one function (`api/router.js`) and redirects the old
  `/replay` page to the app. It needs a Postgres `DATABASE_URL` (for example Neon from the Vercel Marketplace) and
  `HUDDLE_SECRET`. Optional: AI keys, `VAPID_*` for push, `CRON_SECRET` for the daily sweep. Serverless functions do not
  run a background worker, so queued work runs while members are connected (their long-polls drive it).
- **Any Node host with Postgres**: `npm start` with `DATABASE_URL` set runs the worker in-process.

## Files

| Path | What |
|---|---|
| `server.js` | Local server: static files, API, background worker |
| `api/router.js` | Vercel function (Watch Party API) |
| `lib/http/` | Router and routes |
| `lib/auth/` | Sessions (HttpOnly cookie, server-side hashes) |
| `lib/rooms/` | Rooms, membership, invitations, the per-room event log, long-polling, lifecycle and purge |
| `lib/chat/` | Message fast path, reactions, polls, rendering |
| `lib/moderation/` | Safety gate, lexicon, policy, audit, reports and review |
| `lib/match/` | The four simulated games (`fixture.js`, `sports/`: cricket, F1, basketball, hockey, each with its rules sheet and roster), feed ingestion, cricket scorecard and momentum rules, simulated fans, private rooms' own replays |
| `lib/ai/`, `lib/cohost/` | Provider adapters, failover orchestrator, task schemas and validation, Co-host behaviours |
| `lib/notify/` | Notification policy, push delivery |
| `lib/jobs/` | The job queue, worker, housekeeping |
| `lib/db/` | Database access and migrations |
| `public/index.html`, `public/watch/` | Watch Party UI |
| `test/` | Automated tests (`node --test`) |

Team, driver and player names and team logos belong to their owners and are used only to make the prototype feel real;
the games themselves are made up.
