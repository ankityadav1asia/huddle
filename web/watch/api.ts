// Same-origin JSON client. The session cookie identifies the user; requests never carry user ids or roles.
let serverOffset = 0;

// Server clock estimate (from the Date header), so countdowns do not depend on the device clock.
export const serverNow = () => Date.now() + serverOffset;

export class ApiError extends Error {
  declare status: number;
  declare code: string;

  constructor(status: number, code: string, message: string, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

type RequestOptions = { signal?: AbortSignal };

// Resolves to the parsed JSON body, typed any: each caller reads the fields it needs.
export async function request(method: string, url: string, body: unknown, { signal }: RequestOptions = {}): Promise<any> {
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'Could not reach Huddle. Check your connection.');
  }
  const date = Date.parse(res.headers.get('date') || '');
  if (Number.isFinite(date)) serverOffset = date - Date.now();
  const text = await res.text();
  let data: any = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const e = data?.error || {};
    const { code, message, ...extra } = e;
    throw new ApiError(res.status, code || 'error', message || 'Something went wrong. Please try again.', extra);
  }
  return data;
}

export const api = {
  get: (url: string, opts?: RequestOptions) => request('GET', url, undefined, opts),
  post: (url: string, body: unknown = {}, opts?: RequestOptions) => request('POST', url, body, opts),
  put: (url: string, body: unknown = {}, opts?: RequestOptions) => request('PUT', url, body, opts),
  patch: (url: string, body: unknown = {}, opts?: RequestOptions) => request('PATCH', url, body, opts),
  del: (url: string, opts?: RequestOptions) => request('DELETE', url, undefined, opts),
};

// Client idempotency keys (32 hex characters) for messages, polls and other retryable actions.
export const newKey = () => (crypto.randomUUID ? crypto.randomUUID().replaceAll('-', '') : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));
