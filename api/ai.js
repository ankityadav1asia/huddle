// POST /api/ai  { mode: "tick" | "catchup" | "ask", payload }  ->  { data, provider }
// GET  /api/ai  ->  { live, provider }   (the app uses this to pick live or offline mode)
// Works as a Vercel serverless function and behind server.js locally. The API key never reaches the browser.
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM, TASKS, userPrompt } from '../lib/prompts.js';

const MAX_PAYLOAD = 60_000;
const RATE_LIMIT = 40; // requests per IP per minute; a public demo link should not drain the key
const hits = new Map();

function provider() {
  if (process.env.ANTHROPIC_API_KEY) return { name: 'claude', model: process.env.ANTHROPIC_MODEL || 'claude-opus-5-5' };
  if (process.env.OPENROUTER_API_KEY) return { name: 'openrouter', model: process.env.OPENROUTER_MODEL || 'google/gemini-3.5-flash-lite' };
  if (process.env.GEMINI_API_KEY) return { name: 'gemini', model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite' };
  return null;
}

function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT;
}

let client;

async function callClaude(model, task, payload) {
  client ||= new Anthropic({ timeout: 25_000, maxRetries: 1 });
  const params = {
    model,
    max_tokens: task.maxTokens,
    system: SYSTEM,
    messages: [{ role: 'user', content: userPrompt(task, payload) }],
    // Low effort keeps each room update fast; the tasks are short and well specified.
    output_config: { effort: process.env.ANTHROPIC_EFFORT || 'low', format: { type: 'json_schema', schema: task.schema } },
  };
  // Server-side refusal fallback is available on the Opus, Sonnet and Fable lines (not Haiku).
  const response = /opus|sonnet|fable/.test(model)
    ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    : await client.messages.create(params);
  if (response.stop_reason === 'refusal') throw new Error('The model declined this request');
  if (response.stop_reason === 'max_tokens') throw new Error('The response was cut off');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

// OpenRouter speaks the OpenAI chat format and can route to Claude, Gemini, GPT and others.
async function callOpenRouter(model, task, payload) {
  const send = async (structured) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25_000);
    try {
      return await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'content-type': 'application/json',
          'HTTP-Referer': process.env.APP_URL || 'http://localhost:3000',
          'X-Title': 'Huddle Watch-Along',
        },
        body: JSON.stringify({
          model,
          max_tokens: task.maxTokens,
          reasoning: { effort: 'low' },
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: `${userPrompt(task, payload)}\n\nReturn JSON that matches this JSON Schema:\n${JSON.stringify(task.schema)}` },
          ],
          ...(structured && { response_format: { type: 'json_schema', json_schema: { name: task.name, strict: true, schema: task.schema } } }),
        }),
      });
    } finally {
      clearTimeout(timer);
    }
  };
  // Some routed models reject strict schemas; the schema is also in the prompt, so retry once without it.
  let res = await send(true);
  if (res.status === 400) res = await send(false);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`OpenRouter returned ${res.status}: ${body?.error?.message || 'no details'}`);
  const choice = body?.choices?.[0];
  if (choice?.finish_reason === 'length') throw new Error('The response was cut off');
  const text = choice?.message?.content || '';
  return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
}

async function callGemini(model, task, payload) {
  const send = async (strict) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25_000);
    try {
      return await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: 'user', parts: [{ text: `${userPrompt(task, payload)}\n\nReturn JSON that matches this JSON Schema:\n${JSON.stringify(task.schema)}` }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            maxOutputTokens: task.maxTokens,
            // Schema-enforced output and light thinking keep each room update fast and parseable.
            ...(strict && { responseJsonSchema: task.schema, thinkingConfig: { thinkingLevel: 'low' } }),
          },
        }),
      });
    } finally {
      clearTimeout(timer);
    }
  };
  // Older models reject responseJsonSchema or thinkingLevel; the schema is also in the prompt, so retry once without them.
  let res = await send(true);
  if (res.status === 400) res = await send(false);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Gemini returned ${res.status}: ${body?.error?.message || 'no details'}`);
  const candidate = body?.candidates?.[0];
  if (candidate?.finishReason === 'MAX_TOKENS') throw new Error('The response was cut off');
  const text = candidate?.content?.parts?.filter((p) => !p.thought).map((p) => p.text || '').join('') || '';
  return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
}

export default async function handler(req, res) {
  const p = provider();
  if (req.method === 'GET') return res.status(200).json({ live: Boolean(p), provider: p ? p.model : null });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST with { mode, payload }.' });
  if (!p) return res.status(503).json({ error: 'No AI key is configured, so the app is using its offline engine.' });

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

  try {
    const call = { claude: callClaude, openrouter: callOpenRouter, gemini: callGemini }[p.name];
    const data = await call(p.model, task, body.payload);
    return res.status(200).json({ data, provider: p.model });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'The AI provider is rate limiting us. The app will use its offline engine for now.' });
    }
    const status = error instanceof Anthropic.APIError ? ` (${error.status})` : '';
    console.error(`AI ${body.mode} failed${status}:`, error.message);
    return res.status(502).json({ error: 'The AI call failed. The app will use its offline engine for this update.' });
  }
}
