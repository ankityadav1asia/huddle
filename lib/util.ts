// Shared helpers: ids, hashing, input checks and errors.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';

export const newId = (prefix) => `${prefix}_${randomBytes(10).toString('hex')}`;
export const newToken = () => randomBytes(32).toString('base64url');
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
// Fails closed: without a server secret nothing that depends on it (OTP hashing, rate-limit keys) runs.
export function hmac(value) {
  const { secret } = config();
  if (!secret) throw new HttpError(503, 'server_not_configured', 'Sign-in is not set up on this server yet.');
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Errors carry a stable code and a safe, user-facing message; nothing internal leaks to clients.
export class HttpError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (message, code = 'invalid_request') => new HttpError(400, code, message);
export const notFound = (message = 'Not found.') => new HttpError(404, 'not_found', message);
export const forbidden = (message = 'You do not have permission to do that.') => new HttpError(403, 'forbidden', message);
export const conflict = (message, code = 'conflict') => new HttpError(409, code, message);

// Control, zero-width and bidi-override characters, built from code points so that no invisible
// character has to appear in this source file.
const INVISIBLE_RANGES = [[0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x7f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069]];
const hex4 = (n) => n.toString(16).padStart(4, '0');
const INVISIBLE = new RegExp(`[${INVISIBLE_RANGES.map(([a, b]) => `\\u${hex4(a)}-\\u${hex4(b)}`).join('')}]`, 'g');

// Text input: trims, normalises Unicode, drops invisible characters, enforces length.
export function cleanText(value, { max = 0, min = 1, field = 'text' }: { max?: number; min?: number; field?: string } = {}) {
  if (typeof value !== 'string') throw badRequest(`${field} must be text.`);
  const text = value.normalize('NFC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  if (text.length < min) throw badRequest(`${field} is empty.`);
  if (max && [...text].length > max) throw badRequest(`${field} is too long (max ${max} characters).`);
  return text;
}

export const isId = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}_[a-f0-9]{20}$`).test(value);

export function requireId(value, prefix, field = 'id') {
  if (!isId(value, prefix)) throw badRequest(`${field} is not valid.`);
  return value;
}

// Only the listed keys are accepted; anything else (attachments, user ids, roles, room types) is rejected.
export function onlyKeys(body, allowed: string[]) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Send a JSON object.');
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) throw badRequest(`Unexpected field: ${extra[0]}.`, 'unexpected_field');
  return body;
}

export const secondsUntil = (date, now = Date.now()) => Math.max(0, Math.ceil((new Date(date).getTime() - now) / 1000));
export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
