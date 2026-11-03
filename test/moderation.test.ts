import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../lib/moderation/classifier.ts';
import { effectivePolicy } from '../lib/moderation/policy.ts';
import { CROWD } from '../lib/match/demo-script.ts';

const LEVELS = ['relaxed', 'balanced', 'strict'];

test('ordinary Hinglish and English cricket banter is never treated as abuse, at any level', () => {
  const lines = Object.values(CROWD).flatMap((t) => Object.values(t).flat());
  assert.ok(lines.length > 150);
  for (const level of LEVELS) {
    for (const line of lines) {
      const d = classify(line.replace(/\{\w+\}/g, '12'), { level });
      assert.ok(['allow', 'flag'].includes(d.action), `${level}: "${line}" -> ${d.action}`);
    }
  }
  for (const line of ['kya maara hai yaar', 'chakka maara!', 'Bumrah killed it with that yorker', 'ye bowling change mistake hai']) {
    assert.equal(classify(line, { level: 'strict' }).action, 'allow', line);
  }
});

test('the mandatory baseline is identical in every room type and at every level', () => {
  const severe = ['tujhe maar dunga', 'I will kill you', 'kys', 'tu mar ja', 'katua log', 'send nudes', 'my number is 98765 43210', 'mail me at fan@example.com'];
  for (const level of LEVELS) {
    for (const text of severe) assert.equal(classify(text, { level }).action, 'reject', `${level}: ${text}`);
  }
});

test('uncertain threats are held for human review instead of being published', () => {
  for (const level of LEVELS) assert.equal(classify('maar dalunga', { level }).action, 'hold');
});

test('levels tune conversational strictness only', () => {
  const at = (text: string) => LEVELS.map((level) => classify(text, { level }).action);
  assert.deepEqual(at('saala kya over tha'), ['allow', 'allow', 'reject']);
  assert.deepEqual(at('you are an idiot'), ['flag', 'reject', 'reject']);
  assert.deepEqual(at('tu chutiya hai'), ['reject', 'reject', 'reject']);
  assert.deepEqual(at('Hardik is an idiot'), ['allow', 'allow', 'reject']);
  assert.deepEqual(at('check www.scam.xyz'), ['allow', 'flag', 'reject']);
});

test('the effective policy comes from the stored room, never the client', () => {
  assert.equal(effectivePolicy({ room_type: 'public', moderation_level: 'relaxed' }).source, 'platform');
  assert.equal(effectivePolicy({ room_type: 'public', moderation_level: 'relaxed' }).level, 'balanced');
  assert.equal(effectivePolicy({ room_type: 'private', moderation_level: 'strict' }).level, 'strict');
  assert.equal(effectivePolicy({ room_type: 'private', moderation_level: 'nonsense' }).level, 'balanced');
});

test('obfuscated abuse is still caught', () => {
  assert.equal(classify('tu ch.u.t.i.y.a hai', { level: 'balanced' }).action, 'reject');
  assert.equal(classify('fuuuuck', { level: 'strict' }).action, 'reject');
});
