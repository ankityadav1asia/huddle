// Web Push (VAPID) sender. Keys come from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY. For local development only,
// a key pair is generated once and kept in .data/vapid.json (git-ignored) so push can be tried without setup.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import type { PushSubscription, RequestOptions, Urgency } from 'web-push';
import { config } from '../config.ts';

// What the lock screen shows: generic text rebuilt from verified data at send time, never chat or room names.
export interface PushPayload { title: string; body: string; url: string; tag: string }
// A stored browser subscription (a push_subscriptions row): the endpoint and the keys to encrypt for.
export interface StoredSubscription { endpoint: string; p256dh: string; auth: string }
// gone: the endpoint no longer exists (404/410), so the subscription can be dropped.
export type PushOutcome = { ok: true } | { ok: false; gone: boolean };
// Sends one message: web-push's sendNotification, or a test's stand-in.
export type PushSender = (subscription: PushSubscription, payload: string, options: RequestOptions) => Promise<unknown>;

let ready: boolean | null = null;
let sender: PushSender | null = null;

function init(): boolean {
  if (ready !== null) return ready;
  const cfg = config();
  let { publicKey, privateKey } = cfg.push;
  if ((!publicKey || !privateKey) && !cfg.hosted && !cfg.databaseUrl) {
    const file = path.join(cfg.dataDir, 'vapid.json');
    if (existsSync(file)) ({ publicKey, privateKey } = JSON.parse(readFileSync(file, 'utf8')));
    else {
      mkdirSync(cfg.dataDir, { recursive: true });
      ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
      writeFileSync(file, JSON.stringify({ publicKey, privateKey }), { mode: 0o600 });
    }
    cfg.push.publicKey = publicKey;
    cfg.push.privateKey = privateKey;
  }
  ready = Boolean(publicKey && privateKey);
  if (ready) webpush.setVapidDetails(cfg.push.subject, publicKey, privateKey);
  return ready;
}

export const pushAvailable = () => init();

// Tests replace the network sender.
export function setPushSender(fn: PushSender) {
  sender = fn;
  ready = true;
}

export async function sendPush(sub: StoredSubscription, payload: PushPayload, { ttlSeconds, urgency }: { ttlSeconds: number; urgency: Urgency }): Promise<PushOutcome> {
  if (!init()) return { ok: false, gone: false };
  const subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
  try {
    await (sender || webpush.sendNotification)(subscription, JSON.stringify(payload), { TTL: ttlSeconds, urgency, timeout: 8000 });
    return { ok: true };
  } catch (err) {
    // web-push rejects with a WebPushError carrying the endpoint's HTTP status; a stand-in may throw anything.
    const status = typeof err === 'object' && err !== null && 'statusCode' in err ? err.statusCode : undefined;
    return { ok: false, gone: status === 404 || status === 410 };
  }
}
