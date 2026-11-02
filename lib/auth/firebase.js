// Firebase Phone Auth. The browser runs Firebase's flow (reCAPTCHA bot check, SMS, code entry) and sends the
// resulting Firebase ID token here once. The server verifies it with Google's public keys (RS256, no
// service-account secret), checks every claim, then opens Huddle's own session. Firebase sessions are not kept.
// Verification follows Firebase's documented checks for third-party JWT libraries.
import { X509Certificate, verify as verifySignature } from 'node:crypto';
import { HttpError, badRequest, hmac } from '../util.js';
import { normalizeIndianMobile } from './phone.js';
import { completeSignIn } from './otp.js';
import { requireToken } from '../limits.js';

const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const SKEW_SECONDS = 60;

let certCache = { keys: null, expires: 0 };

// Google's signing keys, cached for as long as Google's Cache-Control allows.
export async function googleKeys({ fetchImpl = fetch, force = false } = {}) {
  if (!force && certCache.keys && certCache.expires > Date.now()) return certCache.keys;
  const res = await fetchImpl(CERTS_URL);
  if (!res.ok) throw new HttpError(503, 'auth_unavailable', 'Sign-in is temporarily unavailable. Try again shortly.');
  const pems = await res.json();
  const keys = Object.fromEntries(Object.entries(pems).map(([kid, pem]) => [kid, new X509Certificate(pem).publicKey]));
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') || '')?.[1] || 3600);
  certCache = { keys, expires: Date.now() + Math.min(maxAge, 6 * 3600) * 1000 };
  return keys;
}

const invalid = () => new HttpError(400, 'invalid_token', 'Sign-in could not be verified. Try again.');

function decodePart(part) {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
}

// Returns { uid, phone, authTime } or throws. `keys(kid)` resolves a public KeyObject for a key id.
export async function verifyFirebaseIdToken(token, { projectId, keys, now = Date.now() }) {
  if (typeof token !== 'string' || token.length > 4096) throw invalid();
  const parts = token.split('.');
  if (parts.length !== 3) throw invalid();
  const header = decodePart(parts[0]);
  const claims = decodePart(parts[1]);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw invalid();
  const key = await keys(header.kid);
  if (!key) throw invalid();
  const ok = verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw invalid();
  const t = Math.floor(now / 1000);
  if (claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}`) throw invalid();
  if (typeof claims.exp !== 'number' || claims.exp <= t - SKEW_SECONDS) throw invalid();
  if (typeof claims.iat !== 'number' || claims.iat > t + SKEW_SECONDS) throw invalid();
  if (typeof claims.auth_time !== 'number' || claims.auth_time > t + SKEW_SECONDS) throw invalid();
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128) throw invalid();
  if (claims.firebase?.sign_in_provider !== 'phone' || typeof claims.phone_number !== 'string') throw invalid();
  return { uid: claims.sub, phone: claims.phone_number, authTime: claims.auth_time };
}

// Keys by id, refreshing once if Google rotated keys since the cache was filled.
async function keyFor(kid, fetchImpl) {
  let keys = await googleKeys({ fetchImpl });
  if (!keys[kid]) keys = await googleKeys({ fetchImpl, force: true });
  return keys[kid] || null;
}

export async function signInWithFirebase(db, cfg, { idToken, ip }, { keys, now = Date.now(), fetchImpl = fetch } = {}) {
  const fb = cfg.otp.firebase;
  if (cfg.otp.provider !== 'firebase' || !fb.projectId) throw new HttpError(503, 'otp_unavailable', 'Sign-in is not set up on this server yet.');
  await requireToken(db, `fb_signin_ip:${hmac(`ip:${ip}`)}`, { limit: cfg.otp.verifyPerIpPerHour, windowSeconds: 3600 }, 'Too many sign-in attempts from this network. Try again later.');
  if (typeof idToken !== 'string' || !idToken) throw badRequest('Missing sign-in token.', 'invalid_token');
  const verified = await verifyFirebaseIdToken(idToken, { projectId: fb.projectId, keys: keys || ((kid) => keyFor(kid, fetchImpl)), now });
  // A fresh sign-in only: a token from an old Firebase session cannot be replayed to open a Huddle session.
  if (Math.floor(now / 1000) - verified.authTime > fb.maxAuthAgeSeconds) {
    throw new HttpError(401, 'stale_token', 'Sign-in took too long. Please verify your number again.');
  }
  const e164 = normalizeIndianMobile(verified.phone);
  if (!e164) throw new HttpError(403, 'phone_not_supported', 'Huddle sign-in currently supports Indian (+91) mobile numbers only.');
  return completeSignIn(db, e164, { firebaseUid: verified.uid });
}
