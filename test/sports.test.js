import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, signUp, clearCooldown, msgId, logs } from './helpers.js';
import { ingestDue, stateAt } from '../lib/match/feed.js';
import { FIXTURES, schedule } from '../lib/match/fixture.js';
import { setAi } from '../lib/ai/index.js';
import { createOrchestrator } from '../lib/ai/orchestrator.js';
import { pump } from '../lib/jobs/worker.js';

// One shared simulated game per sport, each with its public watch party, scoreboard, moments, threads, fans,
// rules sheet and roster; and questions answered about the moment they were asked.
let app; let fan; let rooms;
const sharedRun = async (sport) => (await app.db.query(
  `SELECT m.id FROM matches m JOIN rooms r ON r.match_id = m.id WHERE r.id = $1`, [rooms.find((r) => r.sport === sport).id])).rows[0].id;
const fixtureOf = (sport) => Object.values(FIXTURES).find((f) => f.sport === sport);
// Plays the shared game of `sport` up to fixture item `i` as fresh plays.
async function playTo(sport, i) {
  const run = await sharedRun(sport);
  const offsets = schedule(fixtureOf(sport), app.cfg.match.ballSeconds);
  await app.db.query(`UPDATE matches SET status = 'live', feed_started_at = now() - $2::float8 * interval '1 second' WHERE id = $1`, [run, offsets[i] + 0.05]);
  await ingestDue(app.db, run);
  return run;
}

before(async () => {
  app = await startApp((cfg) => { cfg.cohost.unansweredDelaySeconds = 0; });
  fan = await signUp(app.base, 'sports_fan');
  rooms = (await fan.get('/api/rooms')).body.public_rooms;
  for (const r of rooms) assert.equal((await fan.post(`/api/rooms/${r.id}/join`)).status, 200);
});
after(async () => { await app.close(); });

test('the home screen offers one public watch party per sport, and every game can be followed', async () => {
  assert.deepEqual(rooms.map((r) => [r.sport, r.match_title]),
    [['cricket', 'MI v CSK'], ['f1', 'Italian Grand Prix'], ['basketball', 'Warriors v Lakers'], ['hockey', 'Oilers v Maple Leafs']]);
  const { matches } = (await fan.get('/api/rooms')).body;
  assert.deepEqual(matches.map((m) => m.sport), ['cricket', 'f1', 'basketball', 'hockey']);
});

test("everyone shows the team they back in the room's sport", async () => {
  const roomOf = (sport) => rooms.find((r) => r.sport === sport).id;
  assert.equal((await fan.put('/api/me/sports/f1', { team: 'FER', picks: ['Charles Leclerc'] })).status, 200);
  const teamIn = async (sport) => (await fan.get(`/api/rooms/${roomOf(sport)}`)).body.members.find((m) => m.id === fan.user.id).team;
  assert.deepEqual([await teamIn('cricket'), await teamIn('f1'), await teamIn('basketball')], ['CSK', 'FER', null]); // none chosen yet
  await clearCooldown(app.db, fan.user.id);
  const sent = await fan.post(`/api/rooms/${roomOf('f1')}/messages`, { client_msg_id: msgId(), text: 'Forza Ferrari!' });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.message.sender.team, 'FER');
  const items = (await fan.get(`/api/rooms/${roomOf('f1')}/events?after=0`)).body.events;
  assert.ok(items.some((e) => e.type === 'message' && e.data.sender.team === 'FER'));
});

test('each sport plays to a consistent final score, with its own moment cards and #threads', async () => {
  const finals = {};
  for (const sport of ['f1', 'basketball', 'hockey']) {
    const f = fixtureOf(sport);
    const run = await playTo(sport, f.items.length - 1);
    const room = rooms.find((r) => r.sport === sport);
    const snap = (await fan.get(`/api/rooms/${room.id}/match`)).body;
    assert.equal(snap.match.sport, sport);
    assert.equal(snap.match.status, 'completed');
    finals[sport] = snap.score.result;
    const triggers = (await app.db.query('SELECT DISTINCT trigger FROM match_signals WHERE match_id = $1', [run])).rows.map((r) => r.trigger);
    assert.ok(triggers.includes('match_result_confirmed'), sport);
    const threads = (await fan.get(`/api/rooms/${room.id}`)).body.threads.map((t) => t.title);
    assert.ok(threads.includes('#result'), sport);
    assert.ok(threads.length >= 4, `${sport}: ${threads}`);
  }
  assert.deepEqual(finals, {
    f1: 'Norris wins, Verstappen second, Leclerc third',
    basketball: 'Warriors win 116-115',
    hockey: 'Oilers win 5-3',
  });
});

test('each public watch party has 200 simulated fans of its own sport', async () => {
  for (const [sport, sides] of [['cricket', ['MI', 'CSK']], ['f1', ['MCL', 'RBR']], ['basketball', ['GSW', 'LAL']], ['hockey', ['EDM', 'TOR']]]) {
    const boot = (await fan.get(`/api/rooms/${rooms.find((r) => r.sport === sport).id}`)).body;
    assert.equal(boot.simulated_fans.length, 200, sport);
    assert.equal(new Set(boot.simulated_fans.map((f) => f.handle)).size, 200, sport);
    assert.ok(boot.simulated_fans.every((f) => sides.includes(f.team)), sport);
  }
});

test('newcomers get the checked rules sheet, the roster and example questions for the room\'s sport', async () => {
  const guide = (await fan.get(`/api/rooms/${rooms.find((r) => r.sport === 'hockey').id}/guide`)).body;
  assert.equal(guide.sport, 'hockey');
  assert.ok(guide.rules.some((r) => r.topic === 'Icing'));
  assert.ok(guide.roster.some((p) => p.name === 'Connor McDavid' && p.team === 'Oilers'));
  assert.ok(guide.examples.includes('What is icing?'));
});

test('a rules question is answered from the rules sheet and the moment it was asked', async () => {
  const sport = 'hockey';
  const room = rooms.find((r) => r.sport === sport).id;
  const ppGoal = fixtureOf(sport).items.findIndex((x) => x.moment === 'power-play-goal');
  const run = await sharedRun(sport);
  await app.db.query('DELETE FROM match_events WHERE match_id = $1', [run]); // replay from the start of the period
  await app.db.query(`UPDATE matches SET status = 'live', backfill_until = -1 WHERE id = $1`, [run]);
  await playTo(sport, ppGoal);
  let prompt = '';
  const provider = {
    name: 'fake', model: 'fake-1',
    async generate(req) {
      prompt = req.user;
      return { content: { type: 'answer', text: 'A power play lasts 2 minutes, unless the team with the extra skater scores: McDavid just did at 15:21.', language: 'english', confidence: 'high', grounding: { status: 'rules_sheet', sourceEventIds: [] }, needsHumanReview: false }, provider: 'fake', model: 'fake-1', requestId: null, latencyMs: 5, usage: { input: 1, output: 1 } };
    },
  };
  setAi(createOrchestrator({ providers: [provider] }));
  await clearCooldown(app.db, fan.user.id);
  const sent = await fan.post(`/api/rooms/${room}/messages`, { client_msg_id: msgId(), text: 'What is a power play?' });
  assert.equal(sent.status, 201);
  const stored = (await app.db.query('SELECT is_question, match_seq FROM messages WHERE id = $1', [sent.body.message.id])).rows[0];
  assert.deepEqual(stored, { is_question: true, match_seq: ppGoal }); // the moment it was asked
  await pump(app.db, { budgetMs: 5000 });
  assert.match(prompt, /RULES_SHEET/);
  assert.match(prompt, /Power play/);
  assert.match(prompt, /MATCH_WHEN_ASKED/);
  assert.match(prompt, /P3 15:21/);
  const answer = (await app.db.query(`SELECT body, ai_meta FROM messages WHERE room_id = $1 AND sender_type = 'ai'`, [room])).rows[0];
  assert.match(answer.body, /2 minutes/);
  assert.equal(answer.ai_meta.asked_at, 'P3 15:21');
  assert.equal(answer.ai_meta.grounding.status, 'rules_sheet');
  assert.ok(!logs.join('\n').includes('What is a power play'), 'questions never reach the logs');
  setAi(createOrchestrator({ providers: [] }));
});

test('a rule answer cannot invent numbers that are neither in the rules sheet nor the match', async () => {
  const room = rooms.find((r) => r.sport === 'basketball').id;
  const provider = {
    name: 'fake', model: 'fake-1',
    async generate() {
      return { content: { type: 'answer', text: 'The shot clock is 35 seconds.', language: 'english', confidence: 'high', grounding: { status: 'rules_sheet', sourceEventIds: [] }, needsHumanReview: false }, provider: 'fake', model: 'fake-1', requestId: null, latencyMs: 5, usage: { input: 1, output: 1 } };
    },
  };
  setAi(createOrchestrator({ providers: [provider] }));
  await clearCooldown(app.db, fan.user.id);
  const sent = await fan.post(`/api/rooms/${room}/messages`, { client_msg_id: msgId(), text: '@huddle what is the shot clock?' });
  assert.equal(sent.status, 201);
  await pump(app.db, { budgetMs: 5000 });
  assert.equal((await app.db.query(`SELECT count(*)::int AS n FROM messages WHERE room_id = $1 AND sender_type = 'ai'`, [room])).rows[0].n, 0);
  assert.equal((await app.db.query('SELECT answer_state FROM messages WHERE id = $1', [sent.body.message.id])).rows[0].answer_state, 'ai_unavailable');
  setAi(createOrchestrator({ providers: [] }));
});

test('a shared game created under an older demo pace plays at the current one once it starts', async () => {
  const run = await sharedRun('cricket');
  await app.db.query(`UPDATE matches SET status = 'scheduled', ball_interval_ms = $2 WHERE id = $1`, [run, app.cfg.match.ballSeconds * 1000]);
  app.cfg.match.defaultSpeed = 0.5;
  try {
    assert.equal((await fan.post(`/api/rooms/${rooms.find((r) => r.sport === 'cricket').id}/join`)).status, 200);
    const m = (await app.db.query('SELECT status, ball_interval_ms FROM matches WHERE id = $1', [run])).rows[0];
    assert.deepEqual(m, { status: 'live', ball_interval_ms: app.cfg.match.ballSeconds * 2000 });
  } finally {
    app.cfg.match.defaultSpeed = 1;
  }
});

test('stateAt rebuilds the game as it stood at any moment', () => {
  const f = fixtureOf('basketball');
  const clutch = f.items.findIndex((x) => x.moment === 'clutch');
  const s = stateAt(f, clutch);
  assert.equal(s.clock, '2:00');
  assert.equal(s.score.LAL + s.score.GSW, 110 + 109);
});
