# Huddle Watch Party API

JSON over HTTPS. Every endpoint except those marked *public* needs the `huddle_session` cookie (set when joining) and
a finished profile. The acting user always comes from the session; request bodies never carry user ids, roles, room
types or moderation levels for another user or room, and unknown fields are rejected with `400 unexpected_field`.
State-changing requests must be `Content-Type: application/json`; multipart, files and attachments get `415`.

Errors: `{ "error": { "code": "…", "message": "safe text", "retry_after"?: seconds, … } }`. Rate limits answer `429`
with a `Retry-After` header. A private room the caller cannot see answers `404`, exactly like a missing room.

The games are fixtures: one scripted game per sport (real team and player names, made-up games), played as a
timestamped feed. Nothing the API returns for people to read calls them simulated, a demo or a replay; the Match
Centre carries the one note that the match data and crowd chat are illustrative (the browser shows it).

## Public
| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | `{ ok, db }` |
| GET | `/api/config` | `auth { mode: guest, available }`, `ai` (availability), `chat` (limits and reactions), `moderation` (levels and the public policy), `retention_hours`, `sports [{ sport, label, title, teams [{ code, name, logo? }], players [{ name, short, team }] }]` and `max_picks` (3): what a fan can back in each sport, and `crowd { fans }` |
| POST | `/api/auth/guest` | `{ handle?, sports? }`, usually `{}`: without a `handle` the server picks one (`fan_` and digits). `sports` is keyed by sport: `{ "<sport>": { team: code \| null, picks?: [names] } }`, a team from that sport (else `400 invalid_team`) and up to 3 different players from it (else `400 invalid_picks`); an unknown sport is `400 invalid_sport` → `201 { user, needs_profile: false }` + session cookie. `400` invalid or unsafe username, `409 handle_taken`, `429` too many new profiles from this network, `503` server not configured |

## Account
| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/logout` | Revokes the session |
| POST | `/api/auth/logout-all` | Revokes every session of this user (all devices) |
| GET | `/api/me` | `{ user: { id, handle, sports, is_moderator }, needs_profile }`. A sport missing from `sports` was never answered (its rooms ask once); `team: null` means the fan backs nobody there |
| PUT | `/api/me/profile` | `{ handle, sports? }` (usernames are 3–20 of a-z 0-9 _). Each sport sent replaces that sport's choice (leaving out its `picks` keeps them, `[]` clears them), `null` forgets it, and sports left out are kept |
| PUT | `/api/me/sports/:sport` | `{ team: code \| null, picks? }` → `{ user }`: one sport's choice, as a room asks it ("Who are you backing?") |
| GET | `/api/me/invitations` | Pending, unexpired invitations to active rooms: the home screen's list (the only place invitations show) |
| GET | `/api/users/search?q=` | Username prefix (≥2 chars), max 10, public fields only: `{ users: [{ id, handle, teams }] }` (`teams`: the codes they back, one per sport) |

## Rooms
| Method | Path | Notes |
|---|---|---|
| GET | `/api/rooms` | `{ public_rooms (live or upcoming matches only, one per sport in the order cricket, kabaddi, football, basketball; each with `sport`, `match_id`, `teams [{ code, name, logo }]` (the game's two teams, `logo` a path like `assets/mi.png`), members, online, max_members, full, joined and `score` (a live game's scoreboard `{ line, sub, note }`, e.g. `{ "line": "CSK 166/3", "sub": "17.3 ov", "note": "CSK need 21 off 15" }`, `{ "line": "JPP 24–23 PAT", "sub": "2H 12:41", note }` or `{ "line": "MBSG 1–1 EBFC", "sub": "72'", note }`, else null)), my_rooms, matches [{ id, title, status, source, sport, sport_name }] }` (ensures each sport's shared game and its public room exist; a finished game gets a fresh run) |
| POST | `/api/rooms` | Private room: `{ name, match_id?, moderation_level?, ai_enabled?, invitee_ids? }` → `201 { room_id, invitations: [{ user_id, result }] }`. `match_id` is the shared game of a sport (from `matches`, or a public room's `match_id`): the room follows that game, like the sport's public watch party; a finished game is `400 invalid_match`. `own_replay` no longer exists (`400 unexpected_field`) |
| GET | `/api/rooms/:id` | Bootstrap for members: room details and notices (`room.match { id, title, status, sport, sport_name }`, `ai_notice`, `retention_notice`), members (each with the `team` they back in this room's sport, as message senders carry it too), `crowd_fans [{ handle, team }]` (the sport's 200 crowd personas in a public room; `[]` in private rooms), the last ~60 items, `threads [{ id, slug, title, about, source: moment\|discussion, messages, created_at, last_active_at }]`, `cursor`, presence, `cooldown_until`, `match_rev`. Ended rooms return `{ room: { status: 'ended' }, items: [] }` |
| GET | `/api/rooms/:id/events?after=<seq>&wait=1&vis=visible\|hidden&rev=<match_rev>` | Long-poll (≤20 s). `{ room, events: [{ seq, type, data }], cursor, presence, match_rev }`; returns early on new room events, or (with `rev`) as soon as the match moves on from that version; `reset: true` when the cursor is ahead; ended rooms return their status and no events |
| GET | `/api/rooms/:id/match` | Match Intelligence: `{ match { id, title, teams, format, status, source, source_label, sport, sport_name, fixture_key }, freshness { updated_at, age_seconds, stale }, score, commentary, crowd [{ id, at, fan, team, text, thread }], rev }`. `commentary` is the last 10 plays, newest first: `[{ event_id, kind, over, symbol, label, text, occurred_at }]` (`over` is the over.ball or the game clock, `null` for a cricket event; `symbol` is a cricket ball's). `score` depends on the sport: cricket (scorecard, rates, `batters [{ name, short, runs, balls, fours, sixes, strike_rate, on_strike }]`, bowler, bowling_card, `fall_of_wickets [{ name, r, b, fours, sixes, how, score, over }]`, partnership, this_over, team_stats, result); kabaddi (half, clock, raiding, do_or_die, teams [{ code, name, score, on_mat, raid_points, tackle_points, all_out_points, extra_points }], raiders, defenders, last_play, result); football (minute, period, teams [{ code, name, score, shots, on_target, corners, fouls, yellow, red }], goals [{ team, scorer, assist, minute, penalty }], cards [{ team, player, minute, card }], last_play, result); basketball (period, clock, teams [{ code, name, score, team_fouls, leaders }], last_play, result). `crowd` is the crowd personas' lines for the plays of the last 45 s, in public rooms only (`[]` in private rooms), the same for everyone in the room; clients show each line at `at`. The `replay` and `moments` fields are gone |
| GET | `/api/rooms/:id/match?detail=1` | The Match Centre: everything above, with `commentary` replaced by **every** play of the game, newest first (at most 300), each `{ event_id, kind, over, symbol, label, text, occurred_at }` with `over` always set: in cricket the over.ball for a ball ("18.4"; a wide sits at the next legal ball) and the overs bowled for an event or an over's end ("18.0"); in the other sports the clock ("2H 12:41", "72'", "Q4 2:31"). `symbol` is set on cricket balls only: "0"–"6", "W", "wd" (and "nb"). An over's end (`kind: overend`) has `label: "End of over"` and a line like "End of over 15: 16 runs. CSK 144/2." Plus `graphs`, by sport — cricket: `{ kind: 'cricket', target: number \| null, overs: [{ over (1-based), runs, wickets, total }] }` (the overs of the feed; wides count in the over they were bowled in; `total` is the innings total at the over's end, the over in progress last; the feed starts after 14 overs, so the first is over 15 and `total` includes the runs before it); kabaddi, football and basketball: `{ kind: 'score', teams: [codeA, codeB], points: [{ label (the clock), a, b }] }` (the score at the start, after each change and now) |
| GET | `/api/rooms/:id/guide` | Members: help for newcomers to the room's sport: `{ sport, sport_name, title, rules [{ topic, text }], roster [{ name, team, role }], examples }`. The rules sheet and roster are the checked material the AI Co-host and Dream Bot answer rule and player questions from |
| POST | `/api/rooms/:id/join` | Public rooms only; `409 room_full` at `PUBLIC_ROOM_MAX_MEMBERS` (100) |
| POST | `/api/rooms/:id/leave` | Not for owners |
| POST | `/api/rooms/:id/end` | Private: owner. Public: platform moderators |
| PATCH | `/api/rooms/:id/settings` | Private, owner/admin: `{ moderation_level?, ai_enabled? }`. Public rooms: `403`. `ai_enabled: false` turns the AI Co-host and Dream Bot off for the room |
| GET / POST | `/api/rooms/:id/invitations` | Owner/admin: list with statuses / `{ invitee_ids }` |
| PUT | `/api/rooms/:id/members/:userId/role` | Owner: `{ role: admin \| member }`; never your own role |
| DELETE | `/api/rooms/:id/members/:userId` | Owner/admin removes a member (not the owner; admins cannot remove admins) |

## Chat, reactions, polls, AI Co-host, Dream Bot
| Method | Path | Notes |
|---|---|---|
| POST | `/api/rooms/:id/messages` | `{ client_msg_id, text (≤500), reply_to?, thread_id? }` → `201 { message, status: visible\|held, cooldown_until, notice? }`. `thread_id` posts into a thread of this room (`400 invalid_thread` otherwise); without it the message joins a thread whose topic it mentions, or a big moment from the last 30 s. Messages carry `thread { id, title }` or `null`. `422 message_rejected { message, categories, moderation_event_id }`, `429 cooldown { retry_after, cooldown_until }`, `429 moderation_pause`, `410 room_ended`. A retry with the same `client_msg_id` returns the original (`duplicate: true`) |
| — | A question nobody answers | A question about the room's sport (a question mark or question word, and one of that sport's terms) gets an AI Co-host answer in the chat after `UNANSWERED_QUESTION_DELAY_SECONDS` (25) unless a human replies first (a reply, or an `@handle` of the asker). The answer is a message with `sender.type: 'ai'` and `ai { label: 'AI Co-host', … }`; the question stores the play it was sent at (`match_seq`), and the answer is built from the game as it stood then, the rules sheet and the roster; `ai.asked_at` is the over or clock and `ai.grounding.status` one of `grounded`, `rules_sheet`, `insufficient_data`, `not_applicable`. An answer the AI cannot give is dropped (the question's `answer_state` becomes `cancelled`). Mentioning `@huddle` does nothing |
| PUT | `/api/rooms/:id/messages/:mid/reactions` | `{ emoji: 🔥\|😂\|😮\|👏\|😢\|🏏, on: boolean }` |
| POST | `/api/rooms/:id/messages/:mid/report` | `{ reason: harassment\|hate\|threat\|spam\|personal_info\|sexual\|misinformation\|other, note? }` |
| POST | `/api/rooms/:id/polls/suggest` | `{ client_request_id }` → `{ poll_id, source: ai\|template }`; one open poll per room |
| POST | `/api/rooms/:id/polls/:pid/vote` | `{ option }` |
| POST | `/api/rooms/:id/catchup` | `{ scope: 'match' }` (the match so far) or `{ since_seq? }` (since the person looked away) → `{ scope, headline, stats [{ label, value }], match_points, thread_points [{ thread, id, text }], room_points, source: ai\|match_data, data_as_of, stale, source_label, note?, label? }`. `stats` come straight from the scoreboard; `thread_points` say what the room is saying on its busiest #threads (members' messages and, in a public room, the crowd). To the requester only |
| POST | `/api/rooms/:id/bot` | Dream Bot, members only: `{ question (1–300 chars), client_request_id (/^[A-Za-z0-9_-]{8,64}$/) }` → `200 { answer, asked_at, grounding, source }`. The answer goes to the asker only: nothing is written to the room's messages or events. It is the Co-host's Q&A on the room's game: the latest state, the recent commentary, the sport's rules sheet and roster (no room chat), with the same output validation (every number must come from that verified data). `asked_at` is the over or clock of the latest play (`null` before the first); `grounding` is `grounded`, `rules_sheet`, `insufficient_data` or `not_applicable` (`null` when unavailable); `source: 'ai'`, or `'unavailable'` with a short honest answer when the AI is not configured, busy, over the room's budget, switched off in the room or its answer is rejected ("Dream Bot can't answer right now. Latest: CSK 157/3 (15.5) · need 30 off 25."), and when the question itself breaks the chat's safety baseline (it is never sent to an AI provider). A retry with the same `client_request_id` within a minute returns the same reply. `400 no_match` for a room without a game, `429 rate_limited { retry_after }` past the per-person AI limit (`AI_USER_REQUESTS_PER_5_MIN`, 6), `410 room_ended` |

Event `type`s: `message`, `message_update` (reactions, moderation, answer state), `poll`, `insight` (a match moment,
which clients show as an AI Co-host message: `{ label, priority, trigger, fact, explanation, source_event_id,
occurred_at }`), `member`, `thread`, `room` (settings changed).

## Invitations, moderation, operations
| Method | Path | Notes |
|---|---|---|
| POST | `/api/invitations/:id/accept` · `/decline` | Invitee only; `410` when expired; `409` when already used |
| POST | `/api/invitations/:id/revoke` | Owner/admin of that room |
| POST | `/api/appeals` | `{ moderation_event_id, note? }` for a decision about your own message |
| GET | `/api/mod/queue` | Moderators: held messages and open reports |
| POST | `/api/mod/messages/:mid` | Moderators: `{ action: approve \| remove \| dismiss }` |
| POST | `/api/mod/appeals/:rid` | Moderators: `{ action: uphold \| overturn }` |
| GET | `/api/ops/metrics` | Moderators: delivery latency, job timings and queue state, AI outcomes/latency/tokens/fallbacks (last hour), moderation counts, purge status |
| GET | `/api/cron/sweep` | Vercel Cron with `Authorization: Bearer $CRON_SECRET` |

## Removed on 3 November 2026
These now answer `404`: `POST /api/rooms/:id/replay` (private rooms' own replay), `POST /api/demo/matches/:id/jump` and
`POST /api/demo/matches` (demo controls), `GET/PUT /api/me/notifications` and `POST/DELETE /api/me/push-subscriptions`
(push notifications), `GET /api/users/demo` (demo friends). `GET /api/config` no longer has `notifications`, `push` or
`demo_controls`; search results no longer have `demo`; the match snapshot no longer has `replay` or `moments`;
`POST /api/rooms` refuses `own_replay`; and `@huddle` in a message no longer asks the AI anything.

`match_rev` in the room bootstrap and long-poll responses is opaque: it changes with every new ball, the game's status
and pace, and a room moving to another game, and clients refetch `/api/rooms/:id/match` when it does. Clients pass
the one they have as `rev`, so a quiet room still gets each ball (and the crowd's lines for it) within about a second.
Opening a room (the bootstrap) counts the viewer as online straight away. `/api/config` gives `chat.cooldown_seconds`
(10 by default, `CHAT_COOLDOWN_SECONDS`) and `crowd.fans`, the number of crowd personas in each public watch party
(200). The games play at `DEMO_SPEED` (0.5 by default): a ball or play roughly every `DEMO_BALL_SECONDS /
DEMO_SPEED` seconds.
