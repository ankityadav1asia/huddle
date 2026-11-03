import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client, signUp, type App } from './helpers.ts';

let app: App;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

test('joining takes one tap: Huddle picks the username, which can be changed later', async () => {
  const c = client(app.base);
  const r = await c.post('/api/auth/guest', {});
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.body.user).sort(), ['handle', 'id', 'is_moderator', 'sports']);
  assert.match(r.body.user.handle, /^fan_\d{4}$/);
  assert.deepEqual(r.body.user.sports, {});
  assert.ok(c.cookie.startsWith('huddle_session='));
  const renamed = await c.put('/api/me/profile', { handle: 'Riya_Fan' });
  assert.equal(renamed.body.user.handle, 'riya_fan');
  assert.equal((await c.put('/api/me/profile', { handle: 'riya_fan', display_name: 'Riya' })).status, 400); // no display names
});

test('joining with a fixed username creates a profile and a session, with no phone or password', async () => {
  const c = client(app.base);
  const r = await c.post('/api/auth/guest', { handle: '@Riya_Sixes', sports: { cricket: { team: 'CSK' } } });
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.body.user).sort(), ['handle', 'id', 'is_moderator', 'sports']);
  assert.equal(r.body.user.handle, 'riya_sixes');
  assert.deepEqual(r.body.user.sports, { cricket: { team: 'CSK', picks: [] } });
  assert.ok(c.cookie.startsWith('huddle_session='));
  assert.match(r.headers.get('set-cookie') ?? '', /HttpOnly; SameSite=Lax/);
  const me = await c.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.handle, 'riya_sixes');
  assert.equal((await c.get('/api/rooms')).status, 200);
});

test('usernames are validated, unique and safety-checked; privileged fields are refused', async () => {
  const c = client(app.base);
  const join = (body: unknown) => c.post('/api/auth/guest', body);
  assert.equal((await join({ handle: 'ab' })).status, 400); // too short
  assert.equal((await join({ handle: 'has space' })).status, 400);
  assert.equal((await join({ handle: 'huddle' })).status, 400); // reserved
  assert.equal((await join({ handle: 'tu_chutiya' })).status, 400);
  assert.equal((await join({ handle: 'call_9876543210' })).status, 400); // personal data in a label
  assert.equal((await join({ display_name: 'X' })).status, 400); // no display names
  assert.equal((await join({ handle: 'team_test', sports: { cricket: { team: 'RCB' } } })).status, 400);
  assert.equal((await join({ handle: 'team_test', sports: { cricket: { team: 'MCL' } } })).status, 400); // an F1 team
  assert.equal((await join({ handle: 'team_test', sports: { tennis: { team: 'X' } } })).status, 400);
  assert.equal((await join('{"handle":"team_test","sports":{"__proto__":{"team":"X"}}}')).status, 400);
  assert.equal((await join({ handle: 'team_test', team: 'CSK' })).status, 400); // teams go per sport
  assert.equal((await join({ handle: 'sneaky_mod', is_moderator: true })).status, 400);
  assert.equal((await join({ handle: 'taken_one' })).status, 201);
  const dup = await client(app.base).post('/api/auth/guest', { handle: 'Taken_One' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'handle_taken');
});

test('new profiles are limited per network, so nobody can mint accounts to dodge the chat limit', async () => {
  app.cfg.guest.perIpPerHour = 2;
  await app.db.query('DELETE FROM rate_events');
  assert.equal((await client(app.base).post('/api/auth/guest', {})).status, 201);
  assert.equal((await client(app.base).post('/api/auth/guest', {})).status, 201);
  const third = await client(app.base).post('/api/auth/guest', {});
  assert.equal(third.status, 429);
  assert.ok(third.body.error.retry_after > 0);
  app.cfg.guest.perIpPerHour = 10_000;
});

test('protected endpoints need a session, and signing out ends it', async () => {
  assert.equal((await client(app.base).get('/api/rooms')).status, 401);
  const c = await signUp(app.base, 'leaver_1');
  assert.equal((await c.post('/api/auth/logout')).status, 200);
  assert.equal((await c.get('/api/me')).status, 401);
});

test('moderators are recognised by account id only, never by a name anyone could pick', async () => {
  const mod = await signUp(app.base, 'real_mod');
  const copycat = await signUp(app.base, 'real_mod_2');
  app.cfg.moderatorUserIds = [mod.user.id];
  assert.equal((await mod.get('/api/me')).body.user.is_moderator, true);
  assert.equal((await copycat.get('/api/me')).body.user.is_moderator, false);
  app.cfg.moderatorUserIds = [];
});

test('without a server secret, joining fails closed', async () => {
  const secret = app.cfg.secret;
  app.cfg.secret = '';
  const r = await client(app.base).post('/api/auth/guest', {});
  assert.equal(r.status, 503);
  assert.equal((await client(app.base).get('/api/config')).body.auth.available, false);
  app.cfg.secret = secret;
});

test('fans pick a team and up to three players in each sport, keep them on edit, or clear them', async () => {
  const config: { max_picks: number; sports: { sport: string; label: string; teams: { code: string }[]; players: { name: string; short: string; team: string }[] }[] }
    = (await client(app.base).get('/api/config')).body;
  assert.equal(config.max_picks, 3);
  assert.deepEqual(config.sports.map((s) => [s.sport, s.label, s.teams.map((t) => t.code)]), [
    ['cricket', 'Cricket', ['MI', 'CSK']], ['f1', 'F1', ['MCL', 'RBR', 'FER', 'MER']],
    ['basketball', 'Basketball', ['GSW', 'LAL']], ['hockey', 'Hockey', ['EDM', 'TOR']]]);
  assert.ok(config.sports[0].players.some((p) => p.name === 'Jasprit Bumrah' && p.short === 'Bumrah' && p.team === 'MI'));
  assert.ok(config.sports[1].players.some((p) => p.name === 'Charles Leclerc' && p.team === 'FER'));
  const c = client(app.base);
  const sports = { cricket: { team: 'CSK', picks: ['MS Dhoni', 'Jasprit Bumrah'] }, f1: { team: 'MCL', picks: ['Lando Norris'] } };
  const r = await c.post('/api/auth/guest', { handle: 'picker_1', sports });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.user.sports, sports);
  assert.deepEqual((await c.get('/api/me')).body.user.sports, sports);
  let n = 0;
  for (const picks of [['Virat Kohli'], ['MS Dhoni', 'MS Dhoni'], ['MS Dhoni', 'Jasprit Bumrah', 'Rohit Sharma', 'Tilak Varma'], 'MS Dhoni', ['Lando Norris']]) {
    const bad = await client(app.base).post('/api/auth/guest', { handle: `bad_picks_${n += 1}`, sports: { cricket: { team: null, picks } } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'invalid_picks');
  }
  const edit = (extra: Record<string, unknown>) => c.put('/api/me/profile', { handle: 'picker_1', ...extra });
  assert.deepEqual((await edit({})).body.user.sports, sports); // left out: kept
  assert.deepEqual((await edit({ sports: { cricket: { team: 'CSK' } } })).body.user.sports.cricket.picks, ['MS Dhoni', 'Jasprit Bumrah']);
  assert.deepEqual((await edit({ sports: { cricket: { team: 'MI', picks: [] } } })).body.user.sports,
    { cricket: { team: 'MI', picks: [] }, f1: sports.f1 });
  assert.deepEqual(Object.keys((await edit({ sports: { f1: null } })).body.user.sports), ['cricket']); // forgotten: asked again

  // One sport at a time: what a room asks when you first watch that sport.
  const pick = (sport: string, body: unknown) => c.put(`/api/me/sports/${sport}`, body);
  assert.deepEqual((await pick('basketball', { team: 'GSW' })).body.user.sports.basketball, { team: 'GSW', picks: [] });
  assert.deepEqual((await pick('hockey', { team: null })).body.user.sports.hockey, { team: null, picks: [] }); // just watching
  assert.equal((await pick('basketball', { team: 'MCL' })).body.error.code, 'invalid_team');
  assert.equal((await pick('tennis', { team: null })).body.error.code, 'invalid_sport');
  assert.equal((await pick('f1', { team: 'MCL', is_moderator: true })).status, 400);
  assert.equal((await client(app.base).put('/api/me/sports/f1', { team: 'MCL' })).status, 401);
  assert.equal((await c.get('/api/me')).body.user.sports.basketball.team, 'GSW');
});

test('user search returns public profile fields only', async () => {
  const a = await signUp(app.base, 'searcher_1');
  await signUp(app.base, 'kavya_kc');
  const r = await a.get('/api/users/search?q=kav');
  assert.equal(r.body.users.length, 1);
  assert.deepEqual(Object.keys(r.body.users[0]).sort(), ['handle', 'id', 'teams']);
  assert.deepEqual(r.body.users[0].teams, ['CSK']);
});
