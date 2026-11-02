// OTP delivery providers behind one interface:
//   start(phone, challengeId) -> { codeHash?, providerRef?, demoCode? }
//   check(phone, code, challenge) -> boolean   (throws HttpError for expired codes or provider outages)
// 'messagecentral' (production) and 'twilio_verify' generate, send and check the code themselves, so Huddle never
// sees, stores or logs it; Huddle keeps only the provider's verification id. 'demo' is for local development only:
// it shows the code on screen, stores an HMAC of it, and is refused in production.
// Both real adapters are unit-tested against mocked APIs; live delivery depends on the account you configure.
import { randomInt } from 'node:crypto';
import { hmac, safeEqual, HttpError } from '../util.js';

const codeHash = (challengeId, code) => hmac(`otp:${challengeId}:${code}`);
const unavailable = (message = 'We could not send a code right now. Try again in a minute.') => new HttpError(503, 'otp_unavailable', message);

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

async function request(fetchImpl, url, { method = 'GET', headers = {}, body } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetchImpl(url, { method, headers, body, signal: ctrl.signal });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body: json || {} };
  } catch {
    return { ok: false, status: 0, body: {} };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- Message Central VerifyNow (India)
// API: GET  /auth/v1/authentication/token?customerId&key=<base64 password>&scope=NEW&country=91 -> { token }
//      POST /verification/v3/send?countryCode=91&customerId&flowType=SMS&mobileNumber&otpLength (header authToken)
//           -> { responseCode: 200, data: { verificationId } }
//      GET  /verification/v3/validateOtp?countryCode=91&mobileNumber&verificationId&customerId&code (header authToken)
//           -> { data: { verificationStatus: 'VERIFICATION_COMPLETED' } }
// Response codes used: 702 wrong code, 703 already verified, 705 expired, 506 request already exists, 800 limit.
const MC_BASE = 'https://cpaas.messagecentral.com';
const TOKEN_TTL_MS = 30 * 60 * 1000;

export function messageCentralProvider({ customerId, password, email }, fetchImpl = fetch) {
  let token = null;
  let tokenAt = 0;
  const qs = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '')).toString();

  async function authToken(force = false) {
    if (!force && token && Date.now() - tokenAt < TOKEN_TTL_MS) return token;
    const key = Buffer.from(password, 'utf8').toString('base64');
    const r = await request(fetchImpl, `${MC_BASE}/auth/v1/authentication/token?${qs({ customerId, key, scope: 'NEW', country: '91', email })}`, { headers: { accept: '*/*' } });
    if (!r.ok || typeof r.body.token !== 'string' || !r.body.token) throw unavailable();
    token = r.body.token;
    tokenAt = Date.now();
    return token;
  }

  // Retries once with a fresh token if the cached one was rejected.
  async function authed(method, path, params) {
    const run = async (t) => request(fetchImpl, `${MC_BASE}${path}?${qs(params)}`, { method, headers: { accept: '*/*', authToken: t } });
    let r = await run(await authToken());
    if (r.status === 401 || r.status === 403) r = await run(await authToken(true));
    return r;
  }

  const responseCode = (r) => Number(r.body.responseCode ?? r.body.data?.responseCode);

  return {
    name: 'messagecentral',
    sendsSms: true,
    async start(phone) {
      const r = await authed('POST', '/verification/v3/send', { countryCode: '91', customerId, flowType: 'SMS', mobileNumber: phone.slice(3), otpLength: '6' });
      const rc = responseCode(r);
      if (rc === 506 || rc === 800 || r.status === 429) {
        throw new HttpError(429, 'rate_limited', 'A code was sent to this number recently. Wait a minute and try again.', { retry_after: 60 });
      }
      const verificationId = r.body.data?.verificationId;
      if (!r.ok || rc !== 200 || verificationId === undefined || verificationId === null) throw unavailable();
      return { providerRef: String(verificationId) };
    },
    async check(phone, code, challenge) {
      if (!challenge.provider_ref) return false;
      const r = await authed('GET', '/verification/v3/validateOtp', {
        countryCode: '91', mobileNumber: phone.slice(3), verificationId: challenge.provider_ref, customerId, code,
      });
      if (r.body.data?.verificationStatus === 'VERIFICATION_COMPLETED') return true;
      const rc = responseCode(r);
      if (rc === 705) throw new HttpError(400, 'otp_expired', 'That code has expired. Request a new one.');
      if ([700, 702, 703, 505].includes(rc) || r.status === 400) return false;
      if (!r.ok || r.status === 0) throw unavailable('We could not check the code right now. Try again.');
      return false;
    },
  };
}

// ---------------------------------------------------------------- Twilio Verify
export function twilioVerifyProvider({ accountSid, authToken, serviceSid }, fetchImpl = fetch) {
  const base = `https://verify.twilio.com/v2/Services/${encodeURIComponent(serviceSid)}`;
  const headers = {
    authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
    'content-type': 'application/x-www-form-urlencoded',
  };
  const post = (path, form) => request(fetchImpl, `${base}${path}`, { method: 'POST', headers, body: new URLSearchParams(form) });
  return {
    name: 'twilio_verify',
    sendsSms: true,
    async start(phone) {
      const r = await post('/Verifications', { To: phone, Channel: 'sms' });
      if (!r.ok) throw unavailable();
      return {};
    },
    async check(phone, code) {
      const r = await post('/VerificationCheck', { To: phone, Code: code });
      return r.ok && r.body?.status === 'approved';
    },
  };
}

// ---------------------------------------------------------------- selection
// One adapter instance per configuration, so Message Central's auth token is reused between requests.
let cached = { key: null, provider: null };
let fetchOverride = null;
export const setOtpFetch = (fn) => { fetchOverride = fn; cached = { key: null, provider: null }; };

function memo(key, make) {
  if (cached.key !== key) cached = { key, provider: make(fetchOverride || fetch) };
  return cached.provider;
}

export function otpProvider(cfg) {
  const o = cfg.otp;
  if (o.provider === 'messagecentral') {
    const m = o.messageCentral;
    if (!m.customerId || !m.password) throw unavailable('Sign-in is not set up on this server yet.');
    return memo(`mc:${m.customerId}:${m.password.length}`, (f) => messageCentralProvider(m, f));
  }
  if (o.provider === 'twilio_verify') {
    const t = o.twilio;
    if (!t.accountSid || !t.authToken || !t.serviceSid) throw unavailable('Sign-in is not set up on this server yet.');
    return memo(`tw:${t.accountSid}`, (f) => twilioVerifyProvider(t, f));
  }
  if (o.provider === 'demo' && o.demoAllowed) return demoProvider;
  throw unavailable('Sign-in is not set up on this server yet.');
}

// What the browser should show: the provider name when sign-in is ready, otherwise 'unavailable'.
export function signInMode(cfg) {
  const o = cfg.otp;
  if (!cfg.secret) return 'unavailable';
  if (o.provider === 'messagecentral') return o.messageCentral.customerId && o.messageCentral.password ? 'messagecentral' : 'unavailable';
  if (o.provider === 'twilio_verify') return o.twilio.accountSid && o.twilio.authToken && o.twilio.serviceSid ? 'twilio_verify' : 'unavailable';
  if (o.provider === 'demo' && o.demoAllowed) return 'demo';
  return 'unavailable';
}
