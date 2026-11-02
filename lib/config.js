// Server configuration. Everything comes from environment variables; secrets never reach the browser.
// Values here are prototype defaults, documented in .env.example and docs/architecture.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Loads KEY=value lines from .env without overriding real environment variables (local dev only).
export function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const env = (name, fallback = '') => (process.env[name] ?? '').trim() || fallback;
const int = (name, fallback) => {
  const n = Number.parseInt(env(name), 10);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (name, fallback) => {
  const v = env(name).toLowerCase();
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
};
const list = (name) => env(name).split(',').map((s) => s.trim()).filter(Boolean);

export const HOSTED = Boolean(process.env.VERCEL);
// Production never allows the demo sign-in, never auto-generates secrets and fails closed when unconfigured.
export const PRODUCTION = HOSTED || process.env.NODE_ENV === 'production';

// A stable server secret signs nothing client-visible; it keys the HMACs that hash OTP codes and phone numbers.
// Hosted deployments must set HUDDLE_SECRET. Local dev generates one and keeps it in .data/ (git-ignored).
function serverSecret(dataDir) {
  const given = env('HUDDLE_SECRET');
  if (given) return given;
  if (PRODUCTION || env('DATABASE_URL')) return '';
  const file = path.join(dataDir, 'dev-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(32).toString('hex');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export function readConfig() {
  const dataDir = path.resolve(ROOT, env('HUDDLE_DATA_DIR', '.data'));
  const otpProvider = env('OTP_PROVIDER', env('FIREBASE_PROJECT_ID') ? 'firebase' : 'demo');
  return {
    port: int('PORT', 3000),
    hosted: HOSTED,
    production: PRODUCTION,
    databaseUrl: env('DATABASE_URL'),
    dataDir,
    secret: serverSecret(dataDir),
    cookieSecure: PRODUCTION || bool('COOKIE_SECURE', false),

    otp: {
      // 'firebase' (Firebase Phone Auth sends and checks the SMS code) | 'twilio_verify' | 'demo' (local only:
      // no SMS, code shown on screen). Production refuses 'demo' outright.
      provider: otpProvider,
      demoAllowed: !PRODUCTION,
      ttlSeconds: 300,
      maxAttempts: 5,
      resendSeconds: 30,
      perNumberPerHour: 5,
      perIpPerHour: 20,
      verifyPerIpPerHour: 30,
      failedPerNumberPerHour: 10,
      globalPerHour: int('OTP_GLOBAL_PER_HOUR', 300), // cost guard against SMS pumping
      firebase: {
        apiKey: env('FIREBASE_API_KEY'),
        authDomain: env('FIREBASE_AUTH_DOMAIN'),
        projectId: env('FIREBASE_PROJECT_ID'),
        appId: env('FIREBASE_APP_ID'),
        maxAuthAgeSeconds: 600,
      },
      twilio: {
        accountSid: env('TWILIO_ACCOUNT_SID'),
        authToken: env('TWILIO_AUTH_TOKEN'),
        serviceSid: env('TWILIO_VERIFY_SERVICE_SID'),
      },
    },
    sessionDays: 30,
    moderatorPhones: list('MODERATOR_PHONES'),

    chat: {
      // Confirmed product rule: one accepted message per user every 30 seconds, across all rooms and devices.
      cooldownSeconds: 30,
      maxLength: 500,
      reactionsPerMinute: 20,
    },

    rooms: {
      inviteTtlHours: int('INVITE_TTL_HOURS', 48),
      maxMembers: 50, // private rooms
      publicMaxMembers: int('PUBLIC_ROOM_MAX_MEMBERS', 100),
      maxInvitesPerRequest: 10,
      maxActiveOwned: 5,
      autoEndMinutesAfterMatch: int('ROOM_AUTO_END_MINUTES_AFTER_MATCH', 10),
      historyWindow: 60,
    },

    retention: {
      messageHours: int('MESSAGE_RETENTION_HOURS', 24),
      deliveryHours: int('DELIVERY_RETENTION_HOURS', 24),
      moderationDays: int('MODERATION_RETENTION_DAYS', 30),
      aiLogDays: int('AI_LOG_RETENTION_DAYS', 7),
    },

    cohost: {
      unansweredDelaySeconds: int('UNANSWERED_QUESTION_DELAY_SECONDS', 25),
      quietMinutes: int('CONTINUITY_QUIET_MINUTES', 3),
      promptCooldownMinutes: int('CONTINUITY_COOLDOWN_MINUTES', 10),
      userAiPer5Min: int('AI_USER_REQUESTS_PER_5_MIN', 6),
      roomAiPer10Min: int('AI_ROOM_REQUESTS_PER_10_MIN', 30),
      pollSeconds: 90,
    },

    ai: {
      primary: env('AI_PRIMARY'),
      fallback: env('AI_FALLBACK'),
      timeoutMs: int('AI_TIMEOUT_MS', 9000),
      deadlineMs: int('AI_DEADLINE_MS', 16000),
      maxConcurrency: int('AI_MAX_CONCURRENCY', 3),
      breakerFailures: 3,
      breakerOpenMs: 30000,
      providers: {
        anthropic: { apiKey: env('ANTHROPIC_API_KEY'), model: env('ANTHROPIC_MODEL', 'claude-opus-5-5'), effort: env('ANTHROPIC_EFFORT', 'low') },
        openrouter: { apiKey: env('OPENROUTER_API_KEY'), model: env('OPENROUTER_MODEL', 'google/gemini-3.5-flash-lite'), appUrl: env('APP_URL', 'http://localhost:3000') },
        gemini: { apiKey: env('GEMINI_API_KEY'), model: env('GEMINI_MODEL', 'gemini-3.5-flash-lite') },
      },
    },

    notify: {
      // Big-moment notifications per person per match: enough to bring people back, never a stream.
      maxPerMatch: Math.min(10, Math.max(1, int('MATCH_ALERTS_PER_USER', 8))),
      minGapSeconds: int('MATCH_ALERT_MIN_GAP_SECONDS', 90),
      priorities: ['high', 'medium'],
    },

    push: {
      publicKey: env('VAPID_PUBLIC_KEY'),
      privateKey: env('VAPID_PRIVATE_KEY'),
      subject: env('VAPID_SUBJECT', 'mailto:huddle-demo@example.com'),
      ttlSeconds: 120,
    },

    match: {
      // Demo fixture pacing: seconds between deliveries in the scripted replay feed.
      ballSeconds: int('DEMO_BALL_SECONDS', 10),
      staleAfterSeconds: 90,
      freshnessSeconds: 45,
    },
    demoControls: bool('DEMO_CONTROLS', !PRODUCTION),
    publicModerationLevel: env('PUBLIC_MODERATION_LEVEL', 'balanced'),
    cronSecret: env('CRON_SECRET'),
    worker: {
      inline: bool('INLINE_WORKER', !HOSTED),
      intervalMs: 500,
    },
  };
}

let current = null;
export function config() {
  current ||= readConfig();
  return current;
}

// Tests swap configuration without touching process.env.
export function setConfig(next) {
  current = next;
  return current;
}
