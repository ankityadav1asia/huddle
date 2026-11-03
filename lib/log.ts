// Structured logs with redaction: ids, categories and timings, never message bodies, prompts, API keys or session tokens.
const SENSITIVE_KEY = /(key|token|secret|authorization|password|cookie|otp|code|phone|body|text|prompt|question|endpoint|auth)$/i;
const SECRET_VALUE = /(sk-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,}|Bearer\s+[A-Za-z0-9._-]{8,}|\+91\d{10}|\b[6-9]\d{9}\b)/g;

// Objects come back as objects (log fields are spread into the line); anything else keeps its kind.
function redact(value: Record<string, unknown>, depth?: number): Record<string, unknown>;
function redact(value: unknown, depth?: number): unknown;
function redact(value: unknown, depth = 0): unknown {
  if (value == null || depth > 4) return value;
  if (typeof value === 'string') return value.replace(SECRET_VALUE, '[redacted]').slice(0, 300);
  // Node and driver errors carry a code that Error's type does not declare.
  if (value instanceof Error) return { name: value.name, code: (value as Error & { code?: unknown }).code, message: redact(value.message) };
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1)]));
  }
  return value;
}

let sink = (line: string) => console.log(line);
export const setLogSink = (fn: (line: string) => void) => { sink = fn; };

function write(level: string, event: string, fields: Record<string, unknown> = {}) {
  sink(JSON.stringify({ t: new Date().toISOString(), level, event, ...redact(fields) }));
}

export const log = {
  info: (event: string, fields?: Record<string, unknown>) => write('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => write('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => write('error', event, fields),
};
