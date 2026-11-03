import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, signUp, clearCooldown, msgId, logs, type App, type Client, type ApiEvent, type ApiThread } from './helpers.ts';
import { ingestDue, stateAt, clearMatchCache } from '../lib/match/feed.ts';
import { FIXTURES, schedule } from '../lib/match/fixture.ts';
import { setAi } from '../lib/ai/index.ts';
import { createOrchestrator } from '../lib/ai/orchestrator.ts';
import type { Provider } from '../lib/ai/providers.ts';
import { pump } from '../lib/jobs/worker.ts';
import { askedContext } from '../lib/cohost/context.ts';

// One shared game per sport, each with its public watch party, scoreboard, moments, threads, fans, rules sheet and
// roster; and questions answered about the moment they were asked.
let app: App; let fan: Client; let rooms: { id: string; sport: string; match_title: string }[];
const sharedRun = async (sport: string) => (await app.db.query(
  `SELECT m.id FROM matches m JOIN rooms r ON r.match_id = m.id WHERE r.id = $1`, [rooms.find((r) => r.sport === sport)!.id])).rows[0].id;
const fixtureOf = (sport: string) => Object.values(FIXTURES).find((f) => f.sport === sport)!;
// Plays the shared game of `sport` up to fixture item `i` as fresh plays.
async function playTo(sport: string, i: number) {
  const run = await sharedRun(sport);
  const offsets = schedule(fixtureOf(sport), app.cfg.match.ballSeconds);
  await app.db.query(`UPDATE matches SET status = 'live', feed_started_at = now() - $2::float8 * interval '1 second' WHERE id = $1`, [run, offsets[i] + 0.05]);
  await ingestDue(app.db, run);
  return run;
}
// Runs queued jobs until the question is settled: a pass handles at most a few jobs, and the games played above leave
// momentum jobs queued ahead of the answer.
async function answerQuestion(messageId: string) {
  for (let i = 0; i < 10; i++) {
    await pump(app.db, { budgetMs: 5000 });
    const { answer_state: state } = (await app.db.query('SELECT answer_state FROM messages WHERE id = $1', [messageId])).rows[0];
    if (!['pending', 'ai_claimed'].includes(state)) return;
  }
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
    [['cricket', 'MI v CSK'], ['kabaddi', 'Jaipur Pink Panthers v Patna Pirates'], ['football', 'Mohun Bagan v East Bengal'], ['basketball', 'Warriors v Lakers']]);
  const { matches } = (await fan.get('/api/rooms')).body;
  assert.deepEqual(matches.map((m: { sport: string }) => m.sport), ['cricket', 'kabaddi', 'football', 'basketball']);
});

test("everyone shows the team they back in the room's sport", async () => {
  const roomOf = (sport: string) => rooms.find((r) => r.sport === sport)!.id;
  assert.equal((await fan.put('/api/me/sports/football', { team: 'EBFC', picks: ['Hamid Ahadad'] })).status, 200);
  const teamIn = async (sport: string) => (await fan.get(`/api/rooms/${roomOf(sport)}`)).body.members.find((m: { id: string }) => m.id === fan.user.id).team;
  assert.deepEqual([await teamIn('cricket'), await teamIn('football'), await teamIn('basketball')], ['CSK', 'EBFC', null]); // none chosen yet
  await clearCooldown(app.db, fan.user.id);
  const sent = await fan.post(`/api/rooms/${roomOf('football')}/messages`, { client_msg_id: msgId(), text: 'Joy East Bengal!' });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.message.sender.team, 'EBFC');
  const items = (await fan.get(`/api/rooms/${roomOf('football')}/events?after=0`)).body.events;
  assert.ok(items.some((e: ApiEvent) => e.type === 'message' && e.data.sender.team === 'EBFC'));
});

test('each sport plays to a consistent final score, with its own moment cards and #threads', async () => {
  const finals: Record<string, string> = {};
  for (const sport of ['kabaddi', 'football', 'basketball']) {
    const f = fixtureOf(sport);
    const run = await playTo(sport, f.items.length - 1);
    const room = rooms.find((r) => r.sport === sport)!;
    const snap = (await fan.get(`/api/rooms/${room.id}/match`)).body;
    assert.equal(snap.match.sport, sport);
    assert.equal(snap.match.status, 'completed');
    finals[sport] = snap.score.result;
    const triggers = (await app.db.query('SELECT DISTINCT trigger FROM match_signals WHERE match_id = $1', [run])).rows.map((r) => r.trigger);
    assert.ok(triggers.includes('match_result_confirmed'), sport);
    const threads = (await fan.get(`/api/rooms/${room.id}`)).body.threads.map((t: ApiThread) => t.title);
    assert.ok(threads.includes('#result'), sport);
    assert.ok(threads.length >= 4, `${sport}: ${threads}`);
  }
  assert.deepEqual(finals, {
    kabaddi: 'KABADDI_RESULT',
    football: 'Mohun Bagan win 3-2',
    basketball: 'Warriors win 116-115',
  });
});

test('each public watch party has 200 simulated fans of its own sport', async () => {
  const sides: [string, string[]][] = [['cricket', ['MI', 'CSK']], ['kabaddi', ['JPP', 'PAT']], ['football', ['MBSG', 'EBFC']], ['basketball', ['GSW', 'LAL']]];
  for (const [sport, teams] of sides) {
    const boot = (await fan.get(`/api/rooms/${rooms.find((r) => r.sport === sport)!.id}`)).body;
    assert.equal(boot.crowd_fans.length, 200, sport);
    assert.equal(new Set(boot.crowd_fans.map((f: { handle: string }) => f.handle)).size, 200, sport);
    assert.ok(boot.crowd_fans.every((f: { team: string }) => teams.includes(f.team)), sport);
  }
});

test('newcomers get the checked rules sheet, the roster and example questions for the room\'s sport', async () => {
  const guide: { sport: string; rules: { topic: string }[]; roster: { name: string; team: string }[]; examples: string[] }
    = (await fan.get(`/api/rooms/${rooms.find((r) => r.sport === 'football')!.id}/guide`)).body;
  assert.equal(guide.sport, 'football');
  assert.ok(guide.rules.some((r) => r.topic === 'Offside'));
  assert.ok(guide.roster.some((p) => p.name === 'Liston Colaco' && p.team === 'Mohun Bagan Super Giant'));
  assert.ok(guide.examples.includes('What is offside?'));
});

test('a rules question is answered from the rules sheet and the moment it was asked', async () => {
  const sport = 'football';
  const room = rooms.find((r) => r.sport === sport)!.id;
  const penalty = fixtureOf(sport).items.findIndex((x) => x.moment === 'penalty');
  const run = await sharedRun(sport);
  await app.db.query('DELETE FROM match_events WHERE match_id = $1', [run]); // play the game again from its start
  clearMatchCache();
  await playTo(sport, penalty);
  let prompt = '';
  const provider: Provider = {
    name: 'fake', model: 'fake-1',
    async generate(req) {
      prompt = req.user;
      return { content: { type: 'answer', text: 'A penalty kick is taken from 11 metres: Mohun Bagan just won one, in minute 89.', language: 'english', confidence: 'high', grounding: { status: 'rules_sheet', sourceEventIds: [] }, needsHumanReview: false }, provider: 'fake', model: 'fake-1', requestId: null, latencyMs: 5, usage: { input: 1, output: 1 } };
    },
  };
  setAi(createOrchestrator({ providers: [provider] }));
  await clearCooldown(app.db, fan.user.id);
  const sent = await fan.post(`/api/rooms/${room}/messages`, { client_msg_id: msgId(), text: 'What is a penalty kick?' });
  assert.equal(sent.status, 201);
  const stored = (await app.db.query('SELECT is_question, match_seq FROM messages WHERE id = $1', [sent.body.message.id])).rows[0];
  assert.deepEqual(stored, { is_question: true, match_seq: penalty }); // the moment it was asked
  await answerQuestion(sent.body.message.id);
  assert.match(prompt, /RULES_SHEET/);
  assert.match(prompt, /Penalty kick/);
  assert.match(prompt, /MATCH_WHEN_ASKED/);
  assert.match(prompt, /89'/);
  const answer = (await app.db.query(`SELECT body, ai_meta FROM messages WHERE room_id = $1 AND sender_type = 'ai'`, [room])).rows[0];
  assert.match(answer.body, /11 metres/);
  assert.equal(answer.ai_meta.asked_at, "89'");
  assert.equal(answer.ai_meta.grounding.status, 'rules_sheet');
  assert.ok(!logs.join('\n').includes('What is a penalty kick'), 'questions never reach the logs');
  setAi(createOrchestrator({ providers: [] }));
});

test('a rule answer cannot invent numbers that are neither in the rules sheet nor the match', async () => {
  const room = rooms.find((r) => r.sport === 'basketball')!.id;
  const provider: Provider = {
    name: 'fake', model: 'fake-1',
    async generate() {
      return { content: { type: 'answer', text: 'The shot clock is 35 seconds.', language: 'english', confidence: 'high', grounding: { status: 'rules_sheet', sourceEventIds: [] }, needsHumanReview: false }, provider: 'fake', model: 'fake-1', requestId: null, latencyMs: 5, usage: { input: 1, output: 1 } };
    },
  };
  setAi(createOrchestrator({ providers: [provider] }));
  await clearCooldown(app.db, fan.user.id);
  const sent = await fan.post(`/api/rooms/${room}/messages`, { client_msg_id: msgId(), text: 'What is the shot clock?' });
  assert.equal(sent.status, 201);
  await answerQuestion(sent.body.message.id);
  assert.equal((await app.db.query(`SELECT count(*)::int AS n FROM messages WHERE room_id = $1 AND sender_type = 'ai'`, [room])).rows[0].n, 0);
  assert.equal((await app.db.query('SELECT answer_state FROM messages WHERE id = $1', [sent.body.message.id])).rows[0].answer_state, 'cancelled');
  setAi(createOrchestrator({ providers: [] }));
});

test('a shared game created under an older pace plays at the current one once it starts', async () => {
  const run = await sharedRun('cricket');
  await app.db.query(`UPDATE matches SET status = 'scheduled', ball_interval_ms = $2 WHERE id = $1`, [run, app.cfg.match.ballSeconds * 1000]);
  app.cfg.match.defaultSpeed = 0.5;
  try {
    assert.equal((await fan.post(`/api/rooms/${rooms.find((r) => r.sport === 'cricket')!.id}/join`)).status, 200);
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

test('a question is placed at the moment it was asked: the clock, or the over and ball in cricket', async () => {
  const at = async (sport: string, seq: number) => (await askedContext(app.db, { match_id: await sharedRun(sport) }, seq))!.whenAsked!.at;
  const cricket = fixtureOf('cricket');
  const ball = cricket.items.findIndex((x) => x.kind === 'ball');
  assert.equal(await at('cricket', ball), `Over ${stateAt(cricket, ball).ball_log.at(-1).label}`);
  assert.equal(await at('cricket', 0), null); // before the first delivery
  const football = fixtureOf('football');
  assert.equal(await at('football', 3), football.items[3].clock);
});
