// Same-origin JSON client. The session cookie identifies the user; requests never carry user ids or roles.
let serverOffset = 0;

// Server clock estimate (from the Date header), so countdowns do not depend on the device clock.
export const serverNow = () => Date.now() + serverOffset;

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

export async function request(method, url, body, { signal } = {}) {
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
  let data = null;
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
  get: (url, opts) => request('GET', url, undefined, opts),
  post: (url, body = {}, opts) => request('POST', url, body, opts),
  put: (url, body = {}, opts) => request('PUT', url, body, opts),
  patch: (url, body = {}, opts) => request('PATCH', url, body, opts),
  del: (url, opts) => request('DELETE', url, undefined, opts),
};

// Client idempotency keys (32 hex characters) for messages, polls and other retryable actions.
export const newKey = () => (crypto.randomUUID ? crypto.randomUUID().replaceAll('-', '') : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));
