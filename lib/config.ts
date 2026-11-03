// Server configuration, all from environment variables with prototype defaults. Secrets never reach the browser.
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

const env = (name: string, fallback = '') => (process.env[name] ?? '').trim() || fallback;
const int = (name: string, fallback: number) => {
  const n = Number.parseInt(env(name), 10);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (name: string, fallback: boolean) => {
  const v = env(name).toLowerCase();
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
};
const list = (name: string) => env(name).split(',').map((s) => s.trim()).filter(Boolean);

const HOSTED = Boolean(process.env.VERCEL);
// Production never auto-generates a secret (it fails closed instead) and forces Secure cookies.
const PRODUCTION = HOSTED || process.env.NODE_ENV === 'production';

// The server secret keys the HMACs for rate-limit keys and network hashes; it signs nothing client-visible.
// Hosted deployments must set HUDDLE_SECRET. Local dev generates one and keeps it in .data/ (git-ignored).
function serverSecret(dataDir: string) {
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
  return {
    port: int('PORT', 3000),
    hosted: HOSTED,
    production: PRODUCTION,
    databaseUrl: env('DATABASE_URL'),
    dataDir,
    secret: serverSecret(dataDir),
    cookieSecure: PRODUCTION || bool('COOKIE_SECURE', false),

    guest: { perIpPerHour: int('GUEST_SIGNUPS_PER_IP_PER_HOUR', 10) },
    sessionDays: 30,
    moderatorUserIds: list('MODERATOR_USER_IDS'),

    chat: {
      // Product rule: one accepted message per user every 10 seconds, across all rooms and devices.
      cooldownSeconds: int('CHAT_COOLDOWN_SECONDS', 10),
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
      moderationDays: int('MODERATION_RETENTION_DAYS', 30),
      aiLogDays: int('AI_LOG_RETENTION_DAYS', 7),
    },

    cohost: {
      unansweredDelaySeconds: int('UNANSWERED_QUESTION_DELAY_SECONDS', 25),
      quietMinutes: int('CONTINUITY_QUIET_MINUTES', 3),
      promptCooldownMinutes: int('CONTINUITY_COOLDOWN_MINUTES', 10),
      // After a big moment or a new discussion #thread: how long the room argues before the Co-host polls it, and the
      // shortest gap between two such polls.
      debatePollDelaySeconds: int('DEBATE_POLL_DELAY_SECONDS', 30),
      debatePollCooldownMinutes: int('DEBATE_POLL_COOLDOWN_MINUTES', 6),
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
        // Grok. The default is xAI's non-reasoning model, for quick answers.
        xai: { apiKey: env('XAI_API_KEY') || env('GROK_API_KEY'), model: env('XAI_MODEL', 'grok-4.20-0309-non-reasoning') },
      },
    },

    match: {
      // Fixture pacing: seconds between deliveries in a scripted game's feed at 1x.
      ballSeconds: int('DEMO_BALL_SECONDS', 10),
      // The pace shared games play at (0.5, 1 or 2). Half speed by default, so a game is easy to follow.
      defaultSpeed: [0.5, 1, 2].includes(Number(env('DEMO_SPEED', '0.5'))) ? Number(env('DEMO_SPEED', '0.5')) : 0.5,
      staleAfterSeconds: 90,
      freshnessSeconds: 45,
    },
    publicModerationLevel: env('PUBLIC_MODERATION_LEVEL', 'balanced'),
    cronSecret: env('CRON_SECRET'),
    worker: {
      inline: bool('INLINE_WORKER', !HOSTED),
      intervalMs: 500,
    },
  };
}

export type Config = ReturnType<typeof readConfig>;

let current: Config | null = null;
export function config(): Config {
  current ||= readConfig();
  return current;
}

// Tests swap configuration without touching process.env.
export function setConfig(next: Config) {
  current = next;
  return current;
}
