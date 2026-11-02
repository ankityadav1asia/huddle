// POST /api/ai  { mode: "tick" | "catchup" | "ask", payload }  ->  { data, provider }
// GET  /api/ai  ->  { live, provider }   (the replay demo uses this to pick live or offline mode)
// The original single-viewer replay endpoint. It now calls the shared provider layer, so it gets the same
// primary/fallback failover and circuit breaker as the Watch Party Co-host. The API key never reaches the browser.
import { config } from '../lib/config.js';
import { configuredProviders } from '../lib/ai/providers.js';
import { createOrchestrator } from '../lib/ai/orchestrator.js';
import { SYSTEM, TASKS, userPrompt } from '../lib/prompts.js';

const MAX_PAYLOAD = 60_000;
const RATE_LIMIT = 40; // requests per IP per minute; a public demo link should not drain the key
const hits = new Map();

function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT;
}

let orchestrator;
function legacyAi() {
  orchestrator ||= createOrchestrator({ providers: configuredProviders(config().ai), timeoutMs: 25_000, deadlineMs: 28_000, maxConcurrency: 4 });
  return orchestrator;
}

export default async function handler(req, res) {
  const o = legacyAi();
  const primary = o.providers[0];
  if (req.method === 'GET') return res.status(200).json({ live: o.available, provider: primary ? primary.model : null });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST with { mode, payload }.' });
  if (!o.available) return res.status(503).json({ error: 'No AI key is configured, so the app is using its offline engine.' });

  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'local').split(',')[0].trim();
  if (limited(ip)) return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const task = TASKS[body?.mode];
  if (!task || !body.payload || typeof body.payload !== 'object') {
    return res.status(400).json({ error: 'Send { mode: "tick" | "catchup" | "ask", payload: { ... } }.' });
  }
  if (JSON.stringify(body.payload).length > MAX_PAYLOAD) return res.status(413).json({ error: 'Payload too large.' });

  const result = await o.run({ task: task.name, system: SYSTEM, user: userPrompt(task, body.payload), schema: task.schema, maxTokens: task.maxTokens });
  if (result.ok) return res.status(200).json({ data: result.value, provider: result.model });
  if (result.category === 'rate_limited' || result.lastCategory === 'rate_limited') {
    return res.status(429).json({ error: 'The AI provider is rate limiting us. The app will use its offline engine for now.' });
  }
  console.error(`AI ${body.mode} failed (${result.category}${result.lastCategory ? `/${result.lastCategory}` : ''})`);
  return res.status(502).json({ error: 'The AI call failed. The app will use its offline engine for this update.' });
}
