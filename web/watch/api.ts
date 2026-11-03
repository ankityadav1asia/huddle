// Same-origin JSON client. The session cookie identifies the user; requests never carry user ids or roles.
let serverOffset = 0;

// Server clock estimate (from the Date header), so countdowns do not depend on the device clock.
export const serverNow = () => Date.now() + serverOffset;

export class ApiError extends Error {
  declare status: number;
  declare code: string;
  // Extra fields of some errors, copied from the error body: message_rejected and the 429 cooldown.
  declare moderation_event_id?: string;
  declare cooldown_until?: string;
  declare retry_after?: number;

  constructor(status: number, code: string, message: string, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

// What a failed action shows: an ApiError's message is written for people, and any other error keeps its own.
export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

type RequestOptions = { signal?: AbortSignal };

// Resolves to the parsed JSON body, typed any: each caller types it as the payload it reads (see below).
export async function request(method: string, url: string, body: unknown, { signal }: RequestOptions = {}): Promise<any> {
  let res: Response;
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
    if (err instanceof Error && err.name === 'AbortError') throw err;
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

// ---------------------------------------------------------------- payloads read by several views
// Only the fields the app reads (docs/api-contract.md); the server sends more.
export type Role = 'owner' | 'admin' | 'member';
export type ModerationLevel = 'relaxed' | 'balanced' | 'strict';

// The team a fan backs in a sport (null: nobody) and up to three of its players.
export interface SportChoice { team: string | null; picks: string[] }

// The signed-in user (GET /api/me and the profile endpoints). Older accounts may have no handle or name yet.
export interface Me {
  id: string;
  handle: string | null;
  display_name: string | null;
  sports: Record<string, SportChoice>; // a sport left out was never answered
  is_moderator: boolean;
}

export interface MeResponse { user: Me; needs_profile: boolean }

// A sport a fan can back a team and players in (demo data).
export interface SportInfo {
  sport: string;
  label: string;
  teams: { code: string; name: string; logo?: string }[];
  players: { name: string; short: string; team: string }[];
}

export interface LevelInfo { id: ModerationLevel; description: string }

// GET /api/config.
export interface Config {
  notifications: { max_per_match: number };
  push: { available: boolean };
  demo_controls: boolean;
  chat: { cooldown_seconds: number; reactions: string[] };
  moderation: { levels: LevelInfo[] };
  sports: SportInfo[];
  max_picks: number;
}

// How one invitation went: 'invited', or why not ('already_member', 'already_invited', 'room_full', 'not_found').
export interface InviteResult { result: string }

// POST /api/rooms: the new private room.
export interface CreatedRoom { room_id: string; invitations: InviteResult[] }
