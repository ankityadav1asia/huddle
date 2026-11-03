import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, signUp, makePrivateRoom, msgId, logs, type App, type Client } from './helpers.ts';
import { setAi } from '../lib/ai/index.ts';
import { createOrchestrator } from '../lib/ai/orchestrator.ts';
import type { GenerateRequest, Provider } from '../lib/ai/providers.ts';
import { DEMO_FIXTURE, schedule } from '../lib/match/fixture.ts';
import { ingestDue } from '../lib/match/feed.ts';

// Dream AI (POST /api/rooms/:id/bot): the Co-host's Q&A, answered to the asker alone.
type Fake = Provider & { requests: GenerateRequest[] };
function fake(text: string, extra: Record<string, unknown> = {}): Fake {
  const p: Fake = {
    name: 'fake', model: 'fake-1', requests: [],
    async generate(req) {
      p.requests.push(req);
      const content = { type: 'answer', text, language: 'english', confidence: 'high', grounding: { status: 'grounded', sourceEventIds: [] }, needsHumanReview: false, ...extra };
      return { content, provider: 'fake', model: 'fake-1', requestId: null, latencyMs: 5, usage: { input: 1, output: 1 } };
    },
  };
  setAi(createOrchestrator({ providers: [p], sleep: async () => {} }));
  return p;
}

let app: App; let fan: Client; let friend: Client; let outsider: Client; let room: string; let matchId: string;
const ask = (c: Client, question: string, id = msgId(), r = room) => c.post(`/api/rooms/${r}/bot`, { question, client_request_id: id });
const roomCounts = async () => (await app.db.query(
  `SELECT (SELECT count(*)::int FROM messages WHERE room_id = $1) AS messages, (SELECT count(*)::int FROM room_events WHERE room_id = $1) AS events,
          (SELECT last_seq FROM rooms WHERE id = $1) AS seq`, [room])).rows[0];

before(async () => {
  app = await startApp();
  fan = await signUp(app.base, 'bot_fan');
  friend = await signUp(app.base, 'bot_friend');
  outsider = await signUp(app.base, 'bot_outsider');
  await fan.get('/api/rooms');
  room = await makePrivateRoom(app, fan, [friend]);
  matchId = (await app.db.query('SELECT match_id FROM rooms WHERE id = $1', [room])).rows[0].match_id;
  // Play the first three items (the timeout, then two balls of the 15th over), then hold the feed there.
  const offsets = schedule(DEMO_FIXTURE, app.cfg.match.ballSeconds);
  await app.db.query(`UPDATE matches SET status = 'live', feed_started_at = now() - $2::float8 * interval '1 second' WHERE id = $1`, [matchId, offsets[2] + 0.05]);
  await ingestDue(app.db, matchId);
  await app.db.query(`UPDATE matches SET feed_started_at = now() + interval '1 hour' WHERE id = $1`, [matchId]);
});
after(async () => { await app.close(); });

test('Dream AI answers the asker privately, from the match data, rules and roster; nothing reaches the room', async () => {
  const p = fake('CSK need 52 off 34, and Dube just hit a six.');
  const before = await roomCounts();
  const r = await ask(fan, 'Kitne runs chahiye CSK ko?');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { answer: 'CSK need 52 off 34, and Dube just hit a six.', asked_at: 'Over 14.2', grounding: 'grounded', source: 'ai' });
  assert.deepEqual(await roomCounts(), before); // no message, no room event
  const [req] = p.requests;
  assert.equal(req.name, 'bot');
  for (const block of ['VERIFIED_MATCH_DATA', 'COMMENTARY', 'MATCH_WHEN_ASKED', 'RULES_SHEET', 'ROSTER', 'QUESTION_UNTRUSTED']) assert.match(req.user, new RegExp(block));
  assert.doesNotMatch(req.user, /ROOM_MESSAGES_UNTRUSTED/); // room chat is not sent
  assert.match(req.system, /illustrative/);
  assert.ok(!logs.join('\n').includes('Kitne runs chahiye'), 'questions never reach the logs');
  // A retry with the same request id gets the same reply, without asking the AI again.
  const id = msgId();
  const first = await ask(fan, 'Who is bowling?', id);
  const again = await ask(fan, 'Who is bowling?', id);
  assert.deepEqual(again.body, first.body);
  assert.equal(p.requests.length, 2);
});

test('an answer with a number the verified data does not have is rejected: an honest reply instead', async () => {
  await app.db.query('DELETE FROM rate_events');
  const p = fake('CSK need 99 off 3 now.');
  const r = await ask(fan, 'What does CSK need?');
  assert.equal(r.status, 200);
  assert.equal(p.requests.length, 1);
  assert.deepEqual(r.body, { answer: "Dream AI can't answer right now. Latest: CSK 135/2 (14.2) · need 52 off 34.", asked_at: 'Over 14.2', grounding: null, source: 'unavailable' });
  // The same goes for unsafe text.
  fake('Only an idiot would bowl Tilak there.');
  assert.equal((await ask(fan, 'Should Tilak bowl?')).body.source, 'unavailable');
});

test('without an AI provider, or with AI switched off in the room, the reply says so and gives the latest score', async () => {
  await app.db.query('DELETE FROM rate_events');
  setAi(createOrchestrator({ providers: [] }));
  const none = await ask(friend, 'Who is on strike?');
  assert.equal(none.status, 200);
  assert.equal(none.body.source, 'unavailable');
  assert.match(none.body.answer, /^Dream AI can't answer right now\. Latest: CSK 135\/2/);
  const p = fake('Gaikwad is on strike.');
  assert.equal((await fan.patch(`/api/rooms/${room}/settings`, { ai_enabled: false })).status, 200);
  try {
    const off = await ask(friend, 'Who is on strike?');
    assert.equal(off.body.source, 'unavailable');
    assert.match(off.body.answer, /switched off in this room/);
    assert.equal(p.requests.length, 0);
  } finally {
    await fan.patch(`/api/rooms/${room}/settings`, { ai_enabled: true });
  }
});

test('a question the chat would stop never reaches the AI provider', async () => {
  await app.db.query('DELETE FROM rate_events');
  const p = fake('Sure.');
  const r = await ask(fan, 'call me on 9876543210 after the match');
  assert.equal(r.status, 200);
  assert.equal(r.body.source, 'unavailable');
  assert.equal(p.requests.length, 0);
  const audit = (await app.db.query(`SELECT * FROM moderation_events WHERE event_type = 'bot_question_blocked'`)).rows;
  assert.equal(audit.length, 1);
  assert.ok(!JSON.stringify(audit).includes('9876543210'));
});

test('each person has the AI request limit: then 429 with retry_after', async () => {
  await app.db.query('DELETE FROM rate_events');
  fake('Bumrah has two overs left.');
  for (let i = 0; i < app.cfg.cohost.userAiPer5Min; i++) assert.equal((await ask(friend, `Overs left for Bumrah? (${i})`)).status, 200);
  const limited = await ask(friend, 'And now?');
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'rate_limited');
  assert.ok(limited.body.error.retry_after > 0);
  assert.equal(limited.headers.get('retry-after'), String(limited.body.error.retry_after));
  assert.equal((await ask(fan, 'Overs left for Bumrah?')).status, 200); // another person's limit is their own
});

test('members only, a room with a game only, and strict input', async () => {
  await app.db.query('DELETE FROM rate_events');
  fake('Fine.');
  assert.equal((await ask(outsider, 'What is the score?')).status, 404); // a private room reveals nothing
  const noGame = (await fan.post('/api/rooms', { name: 'Just chatting' })).body.room_id;
  const none = await ask(fan, 'What is the score?', msgId(), noGame);
  assert.equal(none.status, 400);
  assert.equal(none.body.error.code, 'no_match');
  assert.equal((await fan.post(`/api/rooms/${room}/bot`, { question: 'Score?' })).status, 400); // no client_request_id
  assert.equal((await fan.post(`/api/rooms/${room}/bot`, { question: 'Score?', client_request_id: 'short' })).status, 400);
  assert.equal((await ask(fan, 'x'.repeat(301))).status, 400);
  assert.equal((await ask(fan, '   ')).status, 400);
  const extra = await fan.post(`/api/rooms/${room}/bot`, { question: 'Score?', client_request_id: msgId(), room_id: room });
  assert.equal(extra.body.error.code, 'unexpected_field');
  const ended = await makePrivateRoom(app, fan, []);
  await fan.post(`/api/rooms/${ended}/end`);
  assert.equal((await ask(fan, 'What is the score?', msgId(), ended)).status, 410);
});
