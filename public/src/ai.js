// Routes each AI task to the live model (via /api/ai) or to the offline engine.
// Live mode switches itself off after repeated failures so the room never stalls.
import * as offline from './local-ai.js';

export const aiState = { mode: 'checking', provider: '', failures: 0 };

async function withTimeout(url, options = {}, ms = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function initAI() {
  const forceOffline = new URLSearchParams(location.search).has('offline') || location.protocol === 'file:';
  if (!forceOffline) {
    try {
      const res = await withTimeout('/api/ai', {}, 4000);
      const body = res.ok ? await res.json() : null;
      if (body?.live) {
        Object.assign(aiState, { mode: 'live', provider: body.provider });
        return aiState;
      }
    } catch {
      // No server or no key: fall through to offline.
    }
  }
  aiState.mode = 'offline';
  return aiState;
}

export async function runAI(task, payload) {
  if (aiState.mode === 'live') {
    try {
      const res = await withTimeout('/api/ai', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: task, payload }),
      }, 30000);
      const body = await res.json().catch(() => null);
      if (res.ok && body?.data) {
        aiState.failures = 0;
        return { data: body.data, source: 'live' };
      }
      console.warn(`Live AI ${task} failed:`, body?.error || res.status);
    } catch (err) {
      console.warn(`Live AI ${task} failed:`, err.message);
    }
    aiState.failures += 1;
    if (aiState.failures >= 3) aiState.mode = 'offline';
  }
  return { data: offline[task](payload), source: 'offline' };
}
