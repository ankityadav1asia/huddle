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
| GET | `/api/config` | `auth { mode: guest, available }`, `notifications { max_per_match }`, push key, demo controls flag, AI availability, chat limits and reactions, moderation levels and the public policy, retention hours, `squads { MI, CSK: [{ name, short }] }` and `max_picks` (3) for picking players |
| POST | `/api/auth/guest` | `{ display_name, handle, team?, picks? }` (`picks`: up to 3 different player names from `squads`, else `400 invalid_picks`) → `201 { user, needs_profile: false }` + session cookie. `400` invalid or unsafe name/handle, `409 handle_taken`, `429` too many new profiles from this network, `503` server not configured |

## Account
| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/logout` | Revokes the session |
| POST | `/api/auth/logout-all` | Revokes every session of this user (all devices) |
| GET | `/api/me` | `{ user: { id, handle, display_name, team, picks, is_moderator }, needs_profile }` |
| PUT | `/api/me/profile` | `{ display_name, handle, team?, picks? }` (handles 3–20 of a-z 0-9 _; leaving out `picks` keeps them, `[]` clears them) |
| GET / PUT | `/api/me/notifications` | `{ push_momentum, push_answers, push_invites }` (+ `push_subscribed`, `push_available`, `vapid_public_key` on GET) |
| POST / DELETE | `/api/me/push-subscriptions` | Browser `PushSubscription.toJSON()` / remove all |
| GET | `/api/me/invitations` | Pending, unexpired invitations to active rooms |
| GET | `/api/users/search?q=` | Handle or display-name prefix (≥2 chars), max 10, public fields only: `{ users: [{ id, handle, name, team, demo }] }`, real profiles first |
| GET | `/api/users/demo` | The labelled demo friends to invite, each with `demo: true` (nobody signs in as them, so their invitations stay pending). `DEMO_USERS=false` empties this list and leaves them out of search |

## Rooms
| Method | Path | Notes |
|---|---|---|
| GET | `/api/rooms` | `{ public_rooms (live or upcoming matches only; each with members, online, max_members, full, joined), my_rooms, matches }` (ensures the demo match, its public room and the demo friends exist) |
| POST | `/api/rooms` | Private room: `{ name, match_id?, own_replay?, moderation_level?, ai_enabled?, invitee_ids? }` → `201 { room_id, invitations: [{ user_id, result }] }`. `match_id` is the shared replay; with `own_replay: true` the room gets its own copy of it instead, waiting for its host to press Start |
| GET | `/api/rooms/:id` | Bootstrap for members: room details and notices, members, the last ~60 items, `cursor`, presence, `cooldown_until`, `match_rev`. Ended rooms return `{ room: { status: 'ended' }, items: [] }` |
| GET | `/api/rooms/:id/events?after=<seq>&wait=1&vis=visible\|hidden&rev=<match_rev>` | Long-poll (≤20 s). `{ room, events: [{ seq, type, data }], cursor, presence, match_rev }`; returns early on new room events, or (with `rev`) as soon as the match moves on from that version; `reset: true` when the cursor is ahead; ended rooms return their status and no events |
| GET | `/api/rooms/:id/match` | Match Intelligence: `{ match (source_label), freshness { updated_at, age_seconds, stale }, score (scorecard, rates, batters, bowling_card, fall_of_wickets, partnership, this_over, team_stats, result), commentary [{ event_id, over, text, occurred_at }], moments (demo), replay { own, paused, speed (1 or 2), moments [{ id, label, passed }], can_control }, crowd [{ id, at, fan, team, text }], rev }`. `crowd` is the simulated fans' lines for the balls of the last 45 s, the same for everyone in the room; clients show each line at `at`. `own` is a private room's own replay; `can_control` is true for its owner and admins |
| POST | `/api/rooms/:id/replay` | A private room's own replay, owner and admins only: `{ action: start\|pause\|resume\|speed\|restart\|jump, speed?: 1\|2, moment? }` → `{ ok, jumped_to? }`. Jumping ahead backfills skipped balls without alerts; jumping back, or restarting, starts a fresh run (6 per room per hour, then 429). 403 in the public room, 409 `not_controllable` in a room following the shared replay, 409 `replay_state` for a control that does not fit (pausing a paused replay) |
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
| POST | `/api/rooms/:id/messages` | `{ client_msg_id, text (≤500), reply_to? }` → `201 { message, status: visible\|held, cooldown_until, notice? }`. `422 message_rejected { message, categories, moderation_event_id }`, `429 cooldown { retry_after, cooldown_until }`, `429 moderation_pause`, `410 room_ended`. A retry with the same `client_msg_id` returns the original (`duplicate: true`) |
| PUT | `/api/rooms/:id/messages/:mid/reactions` | `{ emoji: 🔥\|😂\|😮\|👏\|😢\|🏏, on: boolean }` |
| POST | `/api/rooms/:id/messages/:mid/report` | `{ reason: harassment\|hate\|threat\|spam\|personal_info\|sexual\|misinformation\|other, note? }` |
| POST | `/api/rooms/:id/polls/suggest` | `{ client_request_id }` → `{ poll_id, source: ai\|template }`; one open poll per room |
| POST | `/api/rooms/:id/polls/:pid/vote` | `{ option }` |
| POST | `/api/rooms/:id/catchup` | `{ since_seq? }` → `{ headline, match_points, room_points, source: ai\|match_data, data_as_of, stale, note? }` (to the requester only) |
| — | `@huddle` in a message | Queues an AI answer; a cricket question without a mention is answered after 25 s if no human replies first |

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
| POST | `/api/demo/matches` | `DEMO_CONTROLS` only: start a new demo match run when the last one finished |
| GET | `/api/ops/metrics` | Moderators: delivery latency, job timings and queue state, AI outcomes/latency/tokens/fallbacks (last hour), moderation counts, purge status |
| GET | `/api/cron/sweep` | Vercel Cron with `Authorization: Bearer $CRON_SECRET` |

`match_rev` in the room bootstrap and long-poll responses is opaque: it changes with every new ball and with every
replay control, and clients refetch `/api/rooms/:id/match` when it does. Clients pass the one they have as `rev`, so a
quiet room still gets each ball (and the simulated fans' lines for it) within about a second. Opening a room (the
bootstrap) counts the viewer as online straight away. `/api/config` gives `chat.cooldown_seconds` (10 by default,
`CHAT_COOLDOWN_SECONDS`) and `crowd.fans`, the number of simulated fans.
