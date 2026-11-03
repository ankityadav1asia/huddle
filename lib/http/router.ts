// Minimal JSON router shared by the local server (server.ts) and the Vercel function (api/router.ts).
// Every handler gets the verified user from the session cookie; request bodies never carry identity.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, errorCode, type RequestBody } from '../util.ts';
import { log } from '../log.ts';
import { config, type Config } from '../config.ts';
import { getDb, type Db } from '../db/index.ts';
import { sessionUser, type Session, type SessionUser } from '../auth/sessions.ts';

// On Vercel the request may arrive with its body already read (parsed JSON, a string or a Buffer).
interface ApiRequest extends IncomingMessage { body?: unknown }

interface BaseContext {
  req: ApiRequest;
  res: ServerResponse;
  params: Record<string, string>; // from the route pattern, always present
  query: Record<string, string | undefined>;
  body: RequestBody; // null for GET and DELETE
  db: Db;
  cfg: Config;
  ip: string;
}
// A signed-in route (auth: 'user', the default).
interface RouteContext extends BaseContext { user: SessionUser; session: Session }
// A public route (auth: 'none'): no session is looked up.
interface PublicRouteContext extends BaseContext { user: null; session: null }
// What handleApi builds; route() says which of the two a handler sees.
type DispatchContext = BaseContext & { user: SessionUser | null; session: Session | null };

type Auth = 'user' | 'none';
interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: (ctx: DispatchContext) => unknown;
  auth: Auth;
  profile: boolean;
}

const routes: Route[] = [];
const MAX_BODY = 8 * 1024;
const REPLY = Symbol('reply');

interface Reply { [REPLY]: true; status: number; body: unknown; headers: Record<string, string> }

// Handlers return a plain body (200), or reply(status, body, headers) for anything else.
export const reply = (status: number, body: unknown, headers: Record<string, string> = {}): Reply => ({ [REPLY]: true, status, body, headers });

// profile: whether the route needs a finished profile (a handle) as well as a session.
export function route(method: string, pattern: string, handler: (ctx: RouteContext) => unknown, opts?: { auth?: 'user'; profile?: boolean }): void;
export function route(method: string, pattern: string, handler: (ctx: PublicRouteContext) => unknown, opts: { auth: 'none' }): void;
export function route(method: string, pattern: string, handler: ((ctx: RouteContext) => unknown) | ((ctx: PublicRouteContext) => unknown), opts: { auth?: Auth; profile?: boolean } = {}) {
  const keys: string[] = [];
  const regex = new RegExp(`^${pattern.replace(/:([a-zA-Z]+)/g, (_, k: string) => { keys.push(k); return '([^/]+)'; })}/?$`);
  // handleApi runs a 'user' route only with a signed-in user and a 'none' route without a session; TypeScript cannot follow that.
  routes.push({ method, regex, keys, handler: handler as (ctx: DispatchContext) => unknown, auth: opts.auth ?? 'user', profile: opts.profile ?? true });
}

function match(method: string | undefined, pathname: string) {
  let allowed = false;
  for (const r of routes) {
    const m = r.regex.exec(pathname);
    if (!m) continue;
    if (r.method !== method) { allowed = true; continue; }
    return { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return allowed ? 'method' : null;
}

async function readJson(req: ApiRequest): Promise<RequestBody> {
  if (req.method === 'GET' || req.method === 'DELETE') return null;
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  // Text and emoji only: multipart uploads, images, audio and documents are refused at the boundary.
  if (type !== 'application/json') throw new HttpError(415, 'unsupported_media_type', 'Send JSON. Files and attachments are not accepted.');
  if (typeof req.body === 'object' && req.body !== null && !Buffer.isBuffer(req.body)) return req.body;
  let raw = '';
  if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) raw = String(req.body);
  else {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new HttpError(413, 'payload_too_large', 'Request is too large.');
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  if (raw.length > MAX_BODY) throw new HttpError(413, 'payload_too_large', 'Request is too large.');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON.');
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

const clientIp = (req: ApiRequest) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'local').split(',')[0].trim();

// State-changing requests must come from this origin (cookie auth + CSRF defence alongside SameSite=Lax).
function checkOrigin(req: ApiRequest) {
  if (req.method === 'GET') return;
  const origin = req.headers.origin;
  if (!origin) return;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  try {
    if (new URL(origin).host !== host) throw new HttpError(403, 'bad_origin', 'Cross-site request refused.');
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(403, 'bad_origin', 'Cross-site request refused.');
  }
}

const isReply = (out: unknown): out is Reply => typeof out === 'object' && out !== null && REPLY in out;

export async function handleApi(req: ApiRequest, res: ServerResponse) {
  const started = Date.now();
  // Requests from an http.Server always carry a url.
  const url = new URL(req.url!, 'http://localhost');
  let code = 'ok';
  try {
    const found = match(req.method, url.pathname);
    if (!found) throw new HttpError(404, 'not_found', 'No such endpoint.');
    if (found === 'method') throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
    const { r, params } = found;
    checkOrigin(req);
    const body = await readJson(req);
    const db = await getDb();
    const auth = r.auth === 'none' ? null : await sessionUser(db, req);
    if (r.auth === 'user' && !auth) throw new HttpError(401, 'unauthenticated', 'Sign in to continue.');
    if (r.auth === 'user' && r.profile && !auth!.user.handle) throw new HttpError(403, 'profile_required', 'Finish setting up your profile first.');
    const ctx: DispatchContext = {
      req, res, params, body, db, cfg: config(), ip: clientIp(req),
      query: Object.fromEntries(url.searchParams),
      user: auth?.user || null, session: auth?.session || null,
    };
    const out = await r.handler(ctx);
    if (out === undefined) return; // handler wrote the response itself
    if (isReply(out)) send(res, out.status, out.body, out.headers);
    else send(res, 200, out);
  } catch (err) {
    if (err instanceof HttpError) {
      code = err.code;
      const headers: Record<string, string> = err.extra?.retry_after ? { 'retry-after': String(err.extra.retry_after) } : {};
      send(res, err.status, { error: { code: err.code, message: err.message, ...err.extra } }, headers);
    } else if (errorCode(err) === 'db_not_configured') {
      code = 'db_not_configured';
      send(res, 503, { error: { code, message: 'The Watch Party database is not configured on this server.' } });
    } else {
      code = 'internal';
      log.error('api.error', { path: url.pathname, err });
      send(res, 500, { error: { code: 'internal', message: 'Something went wrong. Please try again.' } });
    }
  } finally {
    if (!url.pathname.endsWith('/events')) log.info('api', { m: req.method, path: url.pathname.replace(/[a-z]+_[a-f0-9]{20}/g, ':id'), result: code, ms: Date.now() - started });
  }
}
