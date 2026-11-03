// AI Co-host orchestration: one backend boundary for every AI task. The fallback provider is tried only for
// transient failures (timeout, 5xx, overload, rate limit) within one overall deadline; safety refusals, invalid
// requests, auth errors, bad responses and output that fails validation end the run.
import { AIError, RETRYABLE, type Provider } from './providers.ts';
import { newId, errorMessage } from '../util.ts';
import type { Queryable } from '../db/index.ts';
import { log } from '../log.ts';

// Per-provider circuit breaker: closed -> open after N consecutive failures -> half-open single probe.
class Breaker {
  threshold: number;
  openMs: number;
  now: () => number;
  state: 'closed' | 'open' | 'half_open';
  count: number;
  openedAt: number;
  probing: boolean;
  constructor({ failures = 3, openMs = 30000, now = Date.now }: { failures?: number; openMs?: number; now?: () => number } = {}) {
    this.threshold = failures;
    this.openMs = openMs;
    this.now = now;
    this.state = 'closed';
    this.count = 0;
    this.openedAt = 0;
    this.probing = false;
  }

  allow() {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (this.now() - this.openedAt < this.openMs) return false;
      this.state = 'half_open';
      this.probing = false;
    }
    if (this.probing) return false;
    this.probing = true;
    return true;
  }

  success() {
    this.state = 'closed';
    this.count = 0;
    this.probing = false;
  }

  failure() {
    this.probing = false;
    if (this.state === 'half_open') {
      this.state = 'open';
      this.openedAt = this.now();
      return;
    }
    this.count += 1;
    if (this.count >= this.threshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }
}

class Semaphore {
  max: number;
  active: number;
  queue: { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }[];
  constructor(max: number) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }

  async acquire(timeoutMs: number): Promise<boolean> {
    if (this.active < this.max) {
      this.active += 1;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const entry = { resolve, timer: setTimeout(() => { this.queue = this.queue.filter((e) => e !== entry); resolve(false); }, timeoutMs) };
      this.queue.push(entry);
    });
  }

  release() {
    const next = this.queue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve(true);
    } else {
      this.active -= 1;
    }
  }
}

const sleepFor = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// What dbRecorder writes to ai_calls for each provider call: metadata only, never prompts, output or keys.
interface CallRecord {
  correlationId: string;
  task: string;
  roomId: string | null;
  userId: string | null;
  provider: string;
  model: string;
  attempt: number; // 0 when the breaker skipped the provider
  outcome: 'ok' | 'rejected' | 'error' | 'skipped';
  error_category: string | null;
  fallback_reason: string | null;
  latency_ms?: number;
  input_tokens?: number | null;
  output_tokens?: number | null;
}

interface OrchestratorOptions {
  providers: Provider[];
  timeoutMs?: number;
  deadlineMs?: number;
  maxConcurrency?: number;
  breaker?: { failures?: number; openMs?: number };
  record?: (r: CallRecord) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; reason: string };

interface RunRequest<T = unknown> {
  task: string;
  system: string;
  user: string;
  schema: Record<string, unknown>; // a JSON Schema object
  maxTokens?: number;
  roomId?: string | null;
  userId?: string | null;
  validate?: (content: unknown) => Validation<T>;
  isCancelled?: () => boolean | Promise<boolean>;
  deadline?: number;
  timeoutMs?: number; // per provider call: shorter than the deadline leaves the fallback provider time to answer
}

// Each shape declares the other's fields as undefined, so a caller can read result.provider before checking ok.
interface RunSuccess<T> {
  ok: true;
  value: T;
  provider: string;
  model: string;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  correlationId: string;
  latencyMs: number;
  category?: undefined;
  reason?: undefined;
  lastCategory?: undefined;
}

// category: not_configured | busy | deadline_exceeded | cancelled | validation_failed | all_providers_failed, or the
// provider's own non-retryable AIError category (safety_refusal, invalid_request, ...).
interface RunFailure {
  ok: false;
  category: string;
  correlationId: string;
  reason?: string; // validation_failed: what the validator rejected
  provider?: string; // the provider whose answer or error ended the run
  fallbackReason?: string | null;
  lastCategory?: string | null;
  value?: undefined;
  model?: undefined;
  fallbackUsed?: undefined;
  latencyMs?: undefined;
}

type RunResult<T> = RunSuccess<T> | RunFailure;

export interface Orchestrator {
  providers: { name: string; model: string }[];
  available: boolean;
  breakerState(name: string): Breaker['state'] | undefined;
  run<T = unknown>(req: RunRequest<T>): Promise<RunResult<T>>;
}

export function createOrchestrator({
  providers, timeoutMs = 9000, deadlineMs = 16000, maxConcurrency = 3, breaker = {},
  record = async () => {}, sleep = sleepFor, now = Date.now, random = Math.random,
}: OrchestratorOptions): Orchestrator {
  const breakers = new Map(providers.map((p) => [p.name, new Breaker({ ...breaker, now })]));
  const gate = new Semaphore(maxConcurrency);

  return {
    providers: providers.map((p) => ({ name: p.name, model: p.model })),
    available: providers.length > 0,
    breakerState: (name: string) => breakers.get(name)?.state,

    // isCancelled() lets a room closure or a human reply stop the run before another provider call starts.
    // Replies are a few hundred tokens; a low cap stops a runaway reply early instead of at the timeout.
    async run<T>({ task, system, user, schema, maxTokens = 2048, roomId = null, userId = null, validate, isCancelled, deadline: ownDeadline, timeoutMs: callTimeout }: RunRequest<T>): Promise<RunResult<T>> {
      const correlationId = newId('aic');
      const started = now();
      const deadline = started + (ownDeadline ?? deadlineMs);
      if (!providers.length) return { ok: false, category: 'not_configured', correlationId };
      if (!(await gate.acquire(Math.max(0, deadline - now() - 1000)))) return { ok: false, category: 'busy', correlationId };
      let fallbackReason: string | null = null;
      let lastCategory: string | null = null;
      try {
        for (let i = 0; i < providers.length; i++) {
          const p = providers[i];
          const br = breakers.get(p.name)!;
          if (!br.allow()) {
            await record({ correlationId, task, roomId, userId, provider: p.name, model: p.model, attempt: 0, outcome: 'skipped', error_category: 'breaker_open', fallback_reason: fallbackReason });
            fallbackReason ||= 'breaker_open';
            lastCategory = 'unavailable';
            continue;
          }
          for (let attempt = 1; attempt <= 2; attempt++) {
            const remaining = deadline - now();
            if (remaining < 1500) return { ok: false, category: 'deadline_exceeded', correlationId, fallbackReason };
            if (isCancelled && (await isCancelled())) return { ok: false, category: 'cancelled', correlationId };
            const t0 = now();
            try {
              const res = await p.generate({ system, user, schema, name: task, maxTokens, timeoutMs: Math.min(callTimeout ?? timeoutMs, remaining - 500) });
              br.success();
              const checked: Validation<T> = validate ? validate(res.content) : { ok: true, value: res.content };
              await record({
                correlationId, task, roomId, userId, provider: res.provider, model: res.model, attempt, outcome: checked.ok ? 'ok' : 'rejected',
                error_category: checked.ok ? null : 'validation_failed', fallback_reason: i > 0 ? fallbackReason : null,
                latency_ms: now() - t0, input_tokens: res.usage?.input, output_tokens: res.usage?.output,
              });
              if (!checked.ok) {
                log.warn('ai.rejected', { task, provider: res.provider, reason: checked.reason, correlationId });
                return { ok: false, category: 'validation_failed', reason: checked.reason, correlationId, provider: res.provider };
              }
              log.info('ai.answered', { task, provider: res.provider, model: res.model, fallback: i > 0, ms: now() - t0, correlationId });
              return { ok: true, value: checked.value, provider: res.provider, model: res.model, fallbackUsed: i > 0, fallbackReason, correlationId, latencyMs: now() - started };
            } catch (err) {
              // Adapters throw AIError; anything else (a bug) counts as the provider being unavailable.
              const failure = err instanceof AIError ? err : null;
              const category = failure?.category || 'unavailable';
              lastCategory = category;
              // The vendor's own error text (never the key) is what tells a bad model name from a bad key or schema.
              log.warn('ai.provider_error', { task, provider: p.name, model: p.model, attempt, category, status: failure?.status ?? null, message: failure?.message ?? errorMessage(err), ms: now() - t0, correlationId });
              await record({ correlationId, task, roomId, userId, provider: p.name, model: p.model, attempt, outcome: 'error', error_category: category, fallback_reason: fallbackReason, latency_ms: now() - t0 });
              // A cut-off or malformed reply is this provider misbehaving, not a refusal: the other one may do better.
              if (category === 'bad_response') {
                fallbackReason ||= category;
                break;
              }
              if (!RETRYABLE.has(category)) {
                // Refusals, bad requests and auth failures stop here: no provider switch.
                return { ok: false, category, correlationId, provider: p.name };
              }
              br.failure();
              const wait = category === 'rate_limited' ? (failure?.retryAfterMs ?? 1000) : 250 + random() * 500;
              const retryHere = attempt === 1 && (category === 'server_error' || (category === 'rate_limited' && wait <= 1500))
                && deadline - now() - wait > 3000 && br.state === 'closed';
              if (retryHere) {
                await sleep(wait);
                continue;
              }
              fallbackReason ||= category;
              break;
            }
          }
        }
        return { ok: false, category: 'all_providers_failed', lastCategory, fallbackReason, correlationId };
      } finally {
        gate.release();
      }
    },
  };
}

export function dbRecorder(db: Queryable) {
  return async (r: CallRecord) => {
    try {
      await db.query(
        `INSERT INTO ai_calls (id, correlation_id, task, room_id, user_id, provider, model, attempt, outcome, error_category, fallback_reason, latency_ms, input_tokens, output_tokens)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [newId('aic'), r.correlationId, r.task, r.roomId, r.userId, r.provider, r.model, r.attempt, r.outcome, r.error_category ?? null,
          r.fallback_reason ?? null, r.latency_ms ?? null, r.input_tokens ?? null, r.output_tokens ?? null]);
    } catch (err) {
      log.warn('ai.record_failed', { err });
    }
  };
}
