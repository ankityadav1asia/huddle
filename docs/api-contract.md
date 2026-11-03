# Huddle Watch Party API

JSON over HTTPS. Every endpoint except those marked *public* needs the `huddle_session` cookie (set when joining) and
a finished profile. The acting user always comes from the session; request bodies never carry user ids, roles, room
types or moderation levels for another user or room, and unknown fields are rejected with `400 unexpected_field`.
State-changing requests must be `Content-Type: application/json`; multipart, files and attachments get `415`.

Errors: `{ "error": { "code": "…", "message": "safe text", "retry_after"?: seconds, … } }`. Rate limits answer `429`
with a `Retry-After` header. A private room the caller cannot see answers `404`, exactly like a missing room.

## Public
| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | `{ ok, db }` |
| GET | `/api/config` | `auth { mode: guest, available }`, `notifications { max_per_match }`, push key, demo controls flag, AI availability, chat limits and reactions, moderation levels and the public policy, retention hours, `sports [{ sport, label, title, teams [{ code, name, logo? }], players [{ name, short, team }] }]` and `max_picks` (3): what a fan can back in each sport |
| POST | `/api/auth/guest` | `{ display_name, handle, sports? }`. `sports` is keyed by sport: `{ "<sport>": { team: code \| null, picks?: [names] } }`, a team from that sport (else `400 invalid_team`) and up to 3 different players from it (else `400 invalid_picks`); an unknown sport is `400 invalid_sport` → `201 { user, needs_profile: false }` + session cookie. `400` invalid or unsafe name/handle, `409 handle_taken`, `429` too many new profiles from this network, `503` server not configured |

## Account
| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/logout` | Revokes the session |
| POST | `/api/auth/logout-all` | Revokes every session of this user (all devices) |
| GET | `/api/me` | `{ user: { id, handle, display_name, sports, is_moderator }, needs_profile }`. A sport missing from `sports` was never answered (its rooms ask once); `team: null` means the fan backs nobody there |
| PUT | `/api/me/profile` | `{ display_name, handle, sports? }` (handles 3–20 of a-z 0-9 _). Each sport sent replaces that sport's choice (leaving out its `picks` keeps them, `[]` clears them), `null` forgets it, and sports left out are kept |
| PUT | `/api/me/sports/:sport` | `{ team: code \| null, picks? }` → `{ user }`: one sport's choice, as a room asks it ("Who are you backing?") |
| GET / PUT | `/api/me/notifications` | `{ push_momentum, push_answers, push_invites }` (+ `push_subscribed`, `push_available`, `vapid_public_key` on GET) |
| POST / DELETE | `/api/me/push-subscriptions` | Browser `PushSubscription.toJSON()` / remove all |
| GET | `/api/me/invitations` | Pending, unexpired invitations to active rooms |
| GET | `/api/users/search?q=` | Handle or display-name prefix (≥2 chars), max 10, public fields only: `{ users: [{ id, handle, name, teams, demo }] }` (`teams`: the codes they back, one per sport), real profiles first |
| GET | `/api/users/demo` | The labelled demo friends to invite, each with `demo: true` (nobody signs in as them, so their invitations stay pending). `DEMO_USERS=false` empties this list and leaves them out of search |

## Rooms
| Method | Path | Notes |
|---|---|---|
| GET | `/api/rooms` | `{ public_rooms (live or upcoming matches only, one per sport in the order cricket, f1, basketball, hockey; each with `sport`, members, online, max_members, full, joined), my_rooms, matches [{ id, title, status, source, sport, sport_name }] }` (ensures each sport's shared simulated game, its public room and the demo friends exist; a finished game gets a fresh run) |
| POST | `/api/rooms` | Private room: `{ name, match_id?, own_replay?, moderation_level?, ai_enabled?, invitee_ids? }` → `201 { room_id, invitations: [{ user_id, result }] }`. `match_id` is a shared simulated game (any sport); with `own_replay: true` the room gets its own copy of it instead, waiting for its host to press Start. The public room's **+ Private room** button sends `{ name, match_id, own_replay, invitee_ids }` for the game that room follows |
| GET | `/api/rooms/:id` | Bootstrap for members: room details and notices (`room.match { id, title, status, sport, sport_name }`), members (each with the `team` they back in this room's sport, as message senders carry it too), `simulated_fans [{ handle, team }]` (the sport's 200 simulated fans in a public room; `[]` in private rooms), the last ~60 items, `threads [{ id, slug, title, about, source: moment\|discussion, messages, created_at, last_active_at }]`, `cursor`, presence, `cooldown_until`, `match_rev`. Ended rooms return `{ room: { status: 'ended' }, items: [] }` |
| GET | `/api/rooms/:id/events?after=<seq>&wait=1&vis=visible\|hidden&rev=<match_rev>` | Long-poll (≤20 s). `{ room, events: [{ seq, type, data }], cursor, presence, match_rev }`; returns early on new room events, or (with `rev`) as soon as the match moves on from that version; `reset: true` when the cursor is ahead; ended rooms return their status and no events |
| GET | `/api/rooms/:id/match` | Match Intelligence: `{ match (source_label, sport, sport_name, fixture_key), freshness { updated_at, age_seconds, stale }, score, commentary [{ event_id, over, text, occurred_at }], moments (demo), replay { own, paused, speed (0.5, 1 or 2), moments [{ id, label, passed }], can_control }, crowd [{ id, at, fan, team, text, thread }], rev }`. `score` depends on the sport: cricket (scorecard, rates, batters, bowling_card, fall_of_wickets, partnership, this_over, team_stats, result); f1 (lap, total_laps, safety_car, leader, order [{ pos, code, name, team, gap, tyre, pits }], fastest_lap, result); basketball (period, clock, teams [{ code, name, score, team_fouls, leaders }], last_play, result); hockey (period, clock, teams [{ code, name, score, shots }], power_play, empty_net, goals, penalties, last_play, result). `over` in commentary is the over.ball or the game clock. `crowd` is the simulated fans' lines for the plays of the last 45 s, in public rooms only (`[]` in private rooms), the same for everyone in the room; clients show each line at `at`. `own` is a private room's own replay; `can_control` is true for its owner and admins |
| GET | `/api/rooms/:id/guide` | Members: help for newcomers to the room's sport: `{ sport, sport_name, title, rules [{ topic, text }], roster [{ name, team, role }], examples }`. The rules sheet and roster are the checked material the Co-host answers rule and player questions from |
| POST | `/api/rooms/:id/replay` | A private room's own replay, owner and admins only: `{ action: start\|pause\|resume\|speed\|restart\|jump, speed?: 0.5\|1\|2, moment? }` → `{ ok, jumped_to? }`. Jumping ahead backfills skipped balls without alerts; jumping back, or restarting, starts a fresh run (6 per room per hour, then 429). 403 in the public room, 409 `not_controllable` in a room following the shared replay, 409 `replay_state` for a control that does not fit (pausing a paused replay) |
| POST | `/api/rooms/:id/join` | Public rooms only; `409 room_full` at `PUBLIC_ROOM_MAX_MEMBERS` (100) |
| POST | `/api/rooms/:id/leave` | Not for owners |
| POST | `/api/rooms/:id/end` | Private: owner. Public: platform moderators |
| PATCH | `/api/rooms/:id/settings` | Private, owner/admin: `{ moderation_level?, ai_enabled? }`. Public rooms: `403` |
| GET / POST | `/api/rooms/:id/invitations` | Owner/admin: list with statuses / `{ invitee_ids }` |
| PUT | `/api/rooms/:id/members/:userId/role` | Owner: `{ role: admin \| member }`; never your own role |
| DELETE | `/api/rooms/:id/members/:userId` | Owner/admin removes a member (not the owner; admins cannot remove admins) |

## Chat, reactions, polls, Co-host
| Method | Path | Notes |
|---|---|---|
| POST | `/api/rooms/:id/messages` | `{ client_msg_id, text (≤500), reply_to?, thread_id? }` → `201 { message, status: visible\|held, cooldown_until, notice? }`. `thread_id` posts into a thread of this room (`400 invalid_thread` otherwise); without it the message joins a thread whose topic it mentions, or a big moment from the last 30 s. Messages carry `thread { id, title }` or `null`. `422 message_rejected { message, categories, moderation_event_id }`, `429 cooldown { retry_after, cooldown_until }`, `429 moderation_pause`, `410 room_ended`. A retry with the same `client_msg_id` returns the original (`duplicate: true`) |
| PUT | `/api/rooms/:id/messages/:mid/reactions` | `{ emoji: 🔥\|😂\|😮\|👏\|😢\|🏏, on: boolean }` |
| POST | `/api/rooms/:id/messages/:mid/report` | `{ reason: harassment\|hate\|threat\|spam\|personal_info\|sexual\|misinformation\|other, note? }` |
| POST | `/api/rooms/:id/polls/suggest` | `{ client_request_id }` → `{ poll_id, source: ai\|template }`; one open poll per room |
| POST | `/api/rooms/:id/polls/:pid/vote` | `{ option }` |
| POST | `/api/rooms/:id/catchup` | `{ since_seq? }` → `{ headline, match_points, room_points, source: ai\|match_data, data_as_of, stale, note? }` (to the requester only) |
| — | `@huddle` in a message | Queues an AI answer; a question about the room's sport without a mention is answered after 25 s if no human replies first. The message stores the play it was sent at (`match_seq`), and the answer is built from the game as it stood then, the rules sheet and the roster; its `ai_meta` carries `asked_at` (the over or clock) and `grounding.status` (`grounded`, `rules_sheet`, `insufficient_data`, `not_applicable`) |

Event `type`s: `message`, `message_update` (reactions, moderation, answer state), `poll`, `insight` (match moment:
`{ label, priority, fact, explanation, trigger, source_event_id, occurred_at }`), `member`, `room` (settings changed).

## Invitations, moderation, demo, operations
| Method | Path | Notes |
|---|---|---|
| POST | `/api/invitations/:id/accept` · `/decline` | Invitee only; `410` when expired; `409` when already used |
| POST | `/api/invitations/:id/revoke` | Owner/admin of that room |
| POST | `/api/appeals` | `{ moderation_event_id, note? }` for a decision about your own message |
| GET | `/api/mod/queue` | Moderators: held messages and open reports |
| POST | `/api/mod/messages/:mid` | Moderators: `{ action: approve \| remove \| dismiss }` |
| POST | `/api/mod/appeals/:rid` | Moderators: `{ action: uphold \| overturn }` |
| POST | `/api/demo/matches/:id/jump` | `DEMO_CONTROLS` only: `{ moment }` jumps the shared simulated replay (skipped balls never alert); 403 for a private room's own replay |
| POST | `/api/demo/matches` | `DEMO_CONTROLS` only: start a new MI v CSK run when the last one finished (every sport also gets a fresh run when `/api/rooms` loads) |
| GET | `/api/ops/metrics` | Moderators: delivery latency, job timings and queue state, AI outcomes/latency/tokens/fallbacks (last hour), moderation counts, purge status |
| GET | `/api/cron/sweep` | Vercel Cron with `Authorization: Bearer $CRON_SECRET` |

`match_rev` in the room bootstrap and long-poll responses is opaque: it changes with every new ball and with every
replay control, and clients refetch `/api/rooms/:id/match` when it does. Clients pass the one they have as `rev`, so a
quiet room still gets each ball (and the simulated fans' lines for it) within about a second. Opening a room (the
bootstrap) counts the viewer as online straight away. `/api/config` gives `chat.cooldown_seconds` (10 by default,
`CHAT_COOLDOWN_SECONDS`) and `crowd.fans`, the number of simulated fans in each public watch party (200). Simulated
games play at `DEMO_SPEED` (0.5 by default): a ball, lap or play roughly every `DEMO_BALL_SECONDS / DEMO_SPEED` seconds.
