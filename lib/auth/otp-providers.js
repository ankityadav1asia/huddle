// OTP delivery providers behind one interface:
//   start(phone, challengeId) -> { codeHash?, demoCode? }
//   check(phone, code, challenge) -> boolean
// 'demo' sends no SMS: it shows the code on screen and stores only an HMAC of it. It does not prove that the
// user owns the number, and the UI says so. 'twilio_verify' hands sending and checking to Twilio Verify, so no
// code is ever stored by Huddle. The Twilio adapter is unit-tested against a mocked API only; confirm India
// DLT/sender rules, pricing and credentials before relying on it.
import { randomInt } from 'node:crypto';
import { hmac, safeEqual, HttpError } from '../util.js';

const codeHash = (challengeId, code) => hmac(`otp:${challengeId}:${code}`);

export const demoProvider = {
  name: 'demo',
  sendsSms: false,
  async start(_phone, challengeId) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    return { codeHash: codeHash(challengeId, code), demoCode: code };
  },
  async check(_phone, code, challenge) {
    return Boolean(challenge.code_hash) && safeEqual(codeHash(challenge.id, code), challenge.code_hash);
  },
};

export function twilioVerifyProvider({ accountSid, authToken, serviceSid }, fetchImpl = fetch) {
  const base = `https://verify.twilio.com/v2/Services/${encodeURIComponent(serviceSid)}`;
  const headers = {
    authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
    'content-type': 'application/x-www-form-urlencoded',
  };
  const post = async (path, form) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetchImpl(`${base}${path}`, { method: 'POST', headers, body: new URLSearchParams(form), signal: ctrl.signal });
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, body };
    } catch {
      return { ok: false, status: 0, body: {} };
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    name: 'twilio_verify',
    sendsSms: true,
    async start(phone) {
      const r = await post('/Verifications', { To: phone, Channel: 'sms' });
      if (!r.ok) throw new HttpError(503, 'otp_unavailable', 'We could not send a code right now. Try again in a minute.');
      return {};
    },
    async check(phone, code) {
      const r = await post('/VerificationCheck', { To: phone, Code: code });
      return r.ok && r.body?.status === 'approved';
    },
  };
}

// The server-side OTP providers. Firebase Phone Auth does not come through here: the browser talks to Firebase
// and the server only verifies the resulting ID token (lib/auth/firebase.js).
export function otpProvider(cfg) {
  if (cfg.otp.provider === 'twilio_verify') {
    const t = cfg.otp.twilio;
    if (!t.accountSid || !t.authToken || !t.serviceSid) throw new HttpError(503, 'otp_unavailable', 'Sign-in is not set up on this server yet.');
    return twilioVerifyProvider(t);
  }
  if (cfg.otp.provider === 'demo' && cfg.otp.demoAllowed) return demoProvider;
  if (cfg.otp.provider === 'firebase') throw new HttpError(400, 'use_firebase', 'This server signs in with Firebase. Reload the page.');
  throw new HttpError(503, 'otp_unavailable', 'Sign-in is not set up on this server yet.');
}

// What the browser should do to sign in: 'firebase', 'twilio_verify', 'demo', or 'unavailable'.
export function signInMode(cfg) {
  const p = cfg.otp.provider;
  if (!cfg.secret) return 'unavailable';
  if (p === 'firebase') return cfg.otp.firebase.projectId && cfg.otp.firebase.apiKey ? 'firebase' : 'unavailable';
  if (p === 'twilio_verify') return cfg.otp.twilio.accountSid && cfg.otp.twilio.authToken && cfg.otp.twilio.serviceSid ? 'twilio_verify' : 'unavailable';
  if (p === 'demo' && cfg.otp.demoAllowed) return 'demo';
  return 'unavailable';
}
