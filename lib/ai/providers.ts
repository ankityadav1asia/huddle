// Provider adapters behind one contract: each translates a common request into its vendor's API and normalises
// every failure into an AIError category (timeout, rate_limited, unavailable, server_error, invalid_request,
// authentication_error, safety_refusal, bad_response). Nothing outside lib/ai calls a vendor directly.
import Anthropic from '@anthropic-ai/sdk';

export interface GenerateRequest {
  system: string;
  user: string;
  schema: Record<string, unknown>; // a JSON Schema object
  name: string;
  maxTokens: number;
  timeoutMs: number;
}

interface GenerateResult {
  content: any; // the model's JSON, parsed but not yet checked: RunRequest.validate decides what may be used
  provider: string;
  model: string;
  requestId: string | null;
  latencyMs: number;
  usage: { input: number | null; output: number | null };
}

export interface Provider {
  name: string;
  model: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

export class AIError extends Error {
  category: string;
  retryAfterMs: number | null;
  status: number | null;
  constructor(category: string, message: string, { retryAfterMs = null, status = null }: { retryAfterMs?: number | null; status?: number | null } = {}) {
    super(message);
    this.category = category;
    this.retryAfterMs = retryAfterMs;
    this.status = status;
  }
}

// Transient infrastructure failures: the only ones that may trigger a retry or the fallback provider.
export const RETRYABLE = new Set(['timeout', 'rate_limited', 'unavailable', 'server_error']);

function categoryForStatus(status: number) {
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'authentication_error';
  if (status === 503 || status === 529) return 'unavailable';
  if (status >= 500) return 'server_error';
  return 'invalid_request';
}

function retryAfterMs(value: string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function parseJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new AIError('bad_response', 'No JSON object in the response');
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new AIError('bad_response', 'The response was not valid JSON');
  }
}

// A vendor's HTTP reply. Its JSON stays untyped at this boundary: each adapter reads only the fields it knows.
interface VendorReply { res: Response; json: any }

async function postJson(fetchImpl: typeof fetch, url: string, { headers, body, timeoutMs }: { headers: Record<string, string>; body: object; timeoutMs: number }): Promise<VendorReply> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    const json = await res.json().catch(() => null);
    return { res, json };
  } catch (err) {
    // An abort rejects with a DOMException, which is an Error.
    if (err instanceof Error && err.name === 'AbortError') throw new AIError('timeout', 'The provider did not answer in time');
    throw new AIError('unavailable', 'Could not reach the provider');
  } finally {
    clearTimeout(timer);
  }
}

function httpFailure(res: Response, json: any, provider: string): AIError {
  const category = categoryForStatus(res.status);
  const msg = typeof json?.error?.message === 'string' ? json.error.message.slice(0, 160) : `HTTP ${res.status}`;
  return new AIError(category, `${provider}: ${msg}`, { status: res.status, retryAfterMs: retryAfterMs(res.headers?.get?.('retry-after')) });
}

// A vendor's settings, as config().ai.providers holds them.
interface ProviderSettings { apiKey: string; model: string }
interface AnthropicSettings extends ProviderSettings { effort: string }
interface OpenRouterSettings extends ProviderSettings { appUrl: string }

function normaliseAnthropic(err: unknown): AIError {
  if (err instanceof AIError) return err;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new AIError('timeout', 'Claude did not answer in time');
  if (err instanceof Anthropic.APIConnectionError) return new AIError('unavailable', 'Could not reach Claude');
  if (err instanceof Anthropic.RateLimitError) {
    return new AIError('rate_limited', 'Claude rate limit', { status: 429, retryAfterMs: retryAfterMs(err.headers?.get?.('retry-after')) });
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return new AIError('authentication_error', 'Claude rejected the credentials', { status: err.status });
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError || err instanceof Anthropic.UnprocessableEntityError) {
    return new AIError('invalid_request', 'Claude rejected the request', { status: err.status });
  }
  if (err instanceof Anthropic.InternalServerError) {
    return new AIError(err.status === 529 || err.type === 'overloaded_error' ? 'unavailable' : 'server_error', 'Claude server error', { status: err.status });
  }
  if (err instanceof Anthropic.APIError) return new AIError(categoryForStatus(err.status || 500), 'Claude error', { status: err.status });
  return new AIError('unavailable', 'Claude call failed');
}

function anthropicAdapter({ apiKey, model, effort }: AnthropicSettings, { client }: { client?: Anthropic } = {}): Provider {
  // SDK retries are off: the orchestrator owns retry, fallback and deadline policy.
  const sdk = client || new Anthropic({ apiKey, maxRetries: 0 });
  return {
    name: 'anthropic',
    model,
    async generate(req) {
      const started = Date.now();
      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
        // ANTHROPIC_EFFORT is sent as configured; the API rejects a level it does not know.
        output_config: { effort: effort as Anthropic.OutputConfig['effort'], format: { type: 'json_schema', schema: req.schema } },
      };
      let res: Anthropic.Message | Anthropic.Beta.BetaMessage;
      try {
        // Anthropic's server-side fallback re-runs a classifier false positive on another Claude model; the
        // orchestrator itself never switches providers on a refusal.
        res = /opus|sonnet|fable/.test(model)
          ? await sdk.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { timeout: req.timeoutMs, maxRetries: 0 })
          : await sdk.messages.create(params, { timeout: req.timeoutMs, maxRetries: 0 });
      } catch (err) {
        throw normaliseAnthropic(err);
      }
      if (res.stop_reason === 'refusal') throw new AIError('safety_refusal', 'Claude declined the request');
      if (res.stop_reason === 'max_tokens') throw new AIError('bad_response', 'The response was cut off');
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      return {
        content: parseJsonObject(text), provider: 'anthropic', model: res.model || model, requestId: res.id,
        latencyMs: Date.now() - started, usage: { input: res.usage?.input_tokens ?? null, output: res.usage?.output_tokens ?? null },
      };
    },
  };
}

// The OpenAI chat-completions format, shared by OpenRouter and xAI.
function chatCompletionsAdapter({ name, label, url, headers = {}, extraBody = {} }: { name: string; label: string; url: string; headers?: Record<string, string>; extraBody?: object },
  { apiKey, model }: ProviderSettings, fetchImpl: typeof fetch): Provider {
  return {
    name,
    model,
    async generate(req) {
      const started = Date.now();
      const send = (structured: boolean) => postJson(fetchImpl, url, {
        timeoutMs: req.timeoutMs,
        headers: { authorization: `Bearer ${apiKey}`, ...headers },
        body: {
          model,
          max_tokens: req.maxTokens,
          ...extraBody,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: `${req.user}\n\nReturn JSON that matches this JSON Schema:\n${JSON.stringify(req.schema)}` },
          ],
          ...(structured && { response_format: { type: 'json_schema', json_schema: { name: req.name, strict: true, schema: req.schema } } }),
        },
      });
      // Some models reject strict schemas; the schema is also in the prompt, so ask once more without it.
      let { res, json } = await send(true);
      if (res.status === 400) ({ res, json } = await send(false));
      if (!res.ok) throw httpFailure(res, json, label);
      const choice = json?.choices?.[0];
      if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) throw new AIError('safety_refusal', 'The model declined the request');
      if (choice?.finish_reason === 'length') throw new AIError('bad_response', 'The response was cut off');
      return {
        content: parseJsonObject(choice?.message?.content || ''), provider: name, model: json?.model || model, requestId: json?.id || null,
        latencyMs: Date.now() - started, usage: { input: json?.usage?.prompt_tokens ?? null, output: json?.usage?.completion_tokens ?? null },
      };
    },
  };
}

export function openRouterAdapter({ apiKey, model, appUrl }: OpenRouterSettings, { fetchImpl = fetch }: { fetchImpl?: typeof fetch } = {}): Provider {
  return chatCompletionsAdapter({
    name: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: { 'HTTP-Referer': appUrl, 'X-Title': 'Huddle Watch Party' }, extraBody: { reasoning: { effort: 'low' } },
  }, { apiKey, model }, fetchImpl);
}

export function xaiAdapter({ apiKey, model }: ProviderSettings, { fetchImpl = fetch }: { fetchImpl?: typeof fetch } = {}): Provider {
  return chatCompletionsAdapter({ name: 'xai', label: 'xAI', url: 'https://api.x.ai/v1/chat/completions' }, { apiKey, model }, fetchImpl);
}

// A part of Gemini's reply: thought summaries are flagged, answer text is not.
interface GeminiPart { text?: string; thought?: boolean }

function geminiAdapter({ apiKey, model }: ProviderSettings, { fetchImpl = fetch }: { fetchImpl?: typeof fetch } = {}): Provider {
  return {
    name: 'gemini',
    model,
    async generate(req) {
      const started = Date.now();
      const send = (strict: boolean) => postJson(fetchImpl, `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        timeoutMs: req.timeoutMs,
        headers: { 'x-goog-api-key': apiKey },
        body: {
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: 'user', parts: [{ text: `${req.user}\n\nReturn JSON that matches this JSON Schema:\n${JSON.stringify(req.schema)}` }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            maxOutputTokens: req.maxTokens,
            ...(strict && { responseJsonSchema: req.schema, thinkingConfig: { thinkingLevel: 'low' } }),
          },
        },
      });
      // Older models reject responseJsonSchema or thinkingLevel; the schema is also in the prompt.
      let { res, json } = await send(true);
      if (res.status === 400) ({ res, json } = await send(false));
      if (!res.ok) throw httpFailure(res, json, 'Gemini');
      if (json?.promptFeedback?.blockReason) throw new AIError('safety_refusal', 'Gemini blocked the request');
      const candidate = json?.candidates?.[0];
      if (['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(candidate?.finishReason)) throw new AIError('safety_refusal', 'Gemini declined the request');
      if (candidate?.finishReason === 'MAX_TOKENS') throw new AIError('bad_response', 'The response was cut off');
      const text: string = candidate?.content?.parts?.filter((p: GeminiPart) => !p.thought).map((p: GeminiPart) => p.text || '').join('') || '';
      return {
        content: parseJsonObject(text), provider: 'gemini', model, requestId: json?.responseId || null,
        latencyMs: Date.now() - started, usage: { input: json?.usageMetadata?.promptTokenCount ?? null, output: json?.usageMetadata?.candidatesTokenCount ?? null },
      };
    },
  };
}

interface SettingsByProvider { anthropic: AnthropicSettings; openrouter: OpenRouterSettings; gemini: ProviderSettings; xai: ProviderSettings }
type ProviderName = keyof SettingsByProvider;

const FACTORIES: { [K in ProviderName]: (settings: SettingsByProvider[K]) => Provider } = { anthropic: anthropicAdapter, openrouter: openRouterAdapter, gemini: geminiAdapter, xai: xaiAdapter };
const DEFAULT_ORDER: ProviderName[] = ['anthropic', 'openrouter', 'gemini', 'xai'];

// config().ai, or the part of it that picks providers. A vendor without an apiKey is skipped, so its settings may be empty.
interface ProviderChoice {
  primary: string;
  fallback: string;
  providers: { [K in ProviderName]: Partial<SettingsByProvider[K]> };
}

// AI_PRIMARY and AI_FALLBACK are free text: only names FACTORIES knows count.
const isProviderName = (name: string): name is ProviderName => name in FACTORIES;

// has() vouched for the API key; a vendor's other settings come from config as they are.
const build = <K extends ProviderName>(name: K, settings: Partial<SettingsByProvider[K]>): Provider => FACTORIES[name](settings as SettingsByProvider[K]);

// Primary and fallback come from AI_PRIMARY / AI_FALLBACK; an unset choice is filled from DEFAULT_ORDER among the
// providers that have keys.
export function configuredProviders(aiCfg: ProviderChoice): Provider[] {
  const has = (name: ProviderName) => Boolean(aiCfg.providers[name]?.apiKey);
  const order: ProviderName[] = [];
  for (const name of [aiCfg.primary, aiCfg.fallback]) if (name && isProviderName(name) && has(name) && !order.includes(name)) order.push(name);
  if (!aiCfg.primary) for (const name of DEFAULT_ORDER) if (has(name) && !order.includes(name)) order.push(name);
  if (!aiCfg.fallback) for (const name of DEFAULT_ORDER) if (has(name) && !order.includes(name) && order.length < 2) order.push(name);
  return order.slice(0, 2).map((name) => build(name, aiCfg.providers[name]));
}
