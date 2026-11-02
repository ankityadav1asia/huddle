// Prototype load check (not part of `npm test`): several rooms, every member long-polling, a burst of messages
// while the AI provider is deliberately slow. Measures send-to-delivery latency and checks that every member gets
// every message exactly once, in order, and that slow AI work does not delay chat.
// Usage: node scripts/load-check.mjs [rooms=3] [membersPerRoom=10]
import { startApp, signUp, makePrivateRoom, msgId } from '../test/helpers.js';
import { setAi } from '../lib/ai/index.js';
import { createOrchestrator } from '../lib/ai/orchestrator.js';
import { startWorker } from '../lib/jobs/worker.js';

const ROOMS = Number(process.argv[2]) || 3;
const MEMBERS = Number(process.argv[3]) || 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

const app = await startApp((cfg) => { cfg.cohost.unansweredDelaySeconds = 3; cfg.ai.maxConcurrency = 3; });
const AI_DELAY = 4000;
let aiCalls = 0;
setAi(createOrchestrator({
  maxConcurrency: 3,
  providers: [{
    name: 'slow', model: 'slow-test',
    async generate() {
      aiCalls += 1;
      await sleep(AI_DELAY);
      return { content: { type: 'answer', text: 'CSK are chasing 187 in this replay.', language: 'english', confidence: 'low', grounding: { status: 'grounded', sourceEventIds: [] }, needsHumanReview: false }, provider: 'slow', model: 'slow-test', usage: {} };
    },
  }],
}));
const stopWorker = startWorker(app.db);

console.log(`Setting up ${ROOMS} rooms x ${MEMBERS} members...`);
const rooms = [];
for (let r = 0; r < ROOMS; r++) {
  const members = [];
  for (let m = 0; m < MEMBERS; m++) members.push(await signUp(app.base, `lr${r}_m${m}`));
  await members[0].get('/api/rooms');
  const id = await makePrivateRoom(app, members[0], members.slice(1));
  rooms.push({ id, members });
}

// Every member long-polls its room and records when each message arrives.
const received = new Map(); // `${member}|${msgId}` -> { at, seq }
const order = new Map(); // member -> [seq...]
const sentAt = new Map(); // message id -> ms
let stop = false;
const loops = rooms.flatMap((room) => room.members.map(async (c) => {
  let cursor = (await c.get(`/api/rooms/${room.id}`)).body.cursor;
  const key = c.user.handle;
  order.set(key, []);
  while (!stop) {
    const r = await c.get(`/api/rooms/${room.id}/events?after=${cursor}&wait=1`);
    const now = Date.now();
    for (const e of r.body.events || []) {
      order.get(key).push(e.seq);
      if (e.type === 'message' && e.data.sender.type === 'user') {
        const k = `${key}|${e.data.id}`;
        if (received.has(k)) received.set(k, { ...received.get(k), dup: true });
        else received.set(k, { at: now, seq: e.seq, room: room.id });
      }
    }
    cursor = r.body.cursor;
  }
}));
await sleep(1000);

// Burst: everyone sends at once (one message each, the per-user rule allows exactly that), a third mention @huddle.
console.log(`Burst: ${ROOMS * MEMBERS} messages within ~1 s, ${Math.ceil(ROOMS * MEMBERS / 3)} of them ask the slow AI...`);
const sends = [];
let i = 0;
for (const room of rooms) {
  for (const c of room.members) {
    const text = i % 3 === 0 ? `@huddle what does CSK need? (${i})` : `burst message ${i}`;
    i += 1;
    sends.push((async () => {
      const t = Date.now();
      const r = await c.post(`/api/rooms/${room.id}/messages`, { client_msg_id: msgId(), text });
      if (r.status === 201) sentAt.set(r.body.message.id, { t, room: room.id, sender: c.user.handle, ack: Date.now() - t });
      return r.status;
    })());
  }
}
const statuses = await Promise.all(sends);

// Wave 2, sent while the slow AI answers are still being generated. The 30 s rule is respected by moving each
// sender's cooldown forward in the database (simulating the wait) rather than sleeping 30 s.
await sleep(1500);
const aiInFlight = aiCalls;
await app.db.query(`UPDATE user_send_cooldowns SET next_allowed_at = now() - interval '1 second'`);
const wave2 = new Set();
await Promise.all(rooms.map(async (room) => {
  const c = room.members[1];
  const t = Date.now();
  const r = await c.post(`/api/rooms/${room.id}/messages`, { client_msg_id: msgId(), text: 'sent while the AI is busy' });
  if (r.status === 201) {
    sentAt.set(r.body.message.id, { t, room: room.id, sender: c.user.handle, ack: Date.now() - t });
    wave2.add(r.body.message.id);
  }
}));
await sleep(AI_DELAY * 3 + 3000); // let the slow AI answers land too
stop = true;
await Promise.race([Promise.all(loops), sleep(25000)]);
stopWorker();

// Results.
const latencies = [];
const wave2Latencies = [];
let missing = 0;
let dups = 0;
for (const [id, s] of sentAt) {
  const room = rooms.find((r) => r.id === s.room);
  for (const c of room.members) {
    if (c.user.handle === s.sender) continue;
    const got = received.get(`${c.user.handle}|${id}`);
    if (!got) missing += 1;
    else {
      (wave2.has(id) ? wave2Latencies : latencies).push(got.at - s.t);
      if (got.dup) dups += 1;
    }
  }
}
let outOfOrder = 0;
for (const seqs of order.values()) for (let k = 1; k < seqs.length; k++) if (seqs[k] <= seqs[k - 1]) outOfOrder += 1;
const acks = [...sentAt.values()].map((s) => s.ack);
const aiMsgs = (await app.db.query(`SELECT count(*)::int AS n FROM messages WHERE sender_type = 'ai'`)).rows[0].n;
console.log(JSON.stringify({
  rooms: ROOMS, members_per_room: MEMBERS,
  accepted: statuses.filter((s) => s === 201).length, rejected: statuses.filter((s) => s !== 201).length,
  send_ack_ms: { p50: pct(acks, 50), p95: pct(acks, 95), max: Math.max(...acks) },
  deliveries: latencies.length, missing, duplicates: dups, out_of_order: outOfOrder,
  burst_send_to_delivery_ms: { p50: pct(latencies, 50), p95: pct(latencies, 95), max: Math.max(...latencies) },
  while_ai_busy_send_to_delivery_ms: { ai_calls_started_before_wave: aiInFlight, deliveries: wave2Latencies.length, p50: pct(wave2Latencies, 50), p95: pct(wave2Latencies, 95), max: Math.max(...wave2Latencies) },
  slow_ai: { delay_ms: AI_DELAY, provider_calls: aiCalls, ai_answers_published: aiMsgs },
}, null, 2));
await app.close();
process.exit(0);
