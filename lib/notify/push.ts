// Web Push (VAPID) sender. Keys come from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY. For local development only,
// a key pair is generated once and kept in .data/vapid.json (git-ignored) so push can be tried without setup.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { config } from '../config.ts';

let ready: boolean | null = null;
let sender = null;

function init() {
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
export function setPushSender(fn) {
  sender = fn;
  ready = true;
}

export async function sendPush(sub, payload, { ttlSeconds, urgency }) {
  if (!init()) return { ok: false, gone: false };
  const subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
  try {
    await (sender || webpush.sendNotification)(subscription, JSON.stringify(payload), { TTL: ttlSeconds, urgency, timeout: 8000 });
    return { ok: true };
  } catch (err) {
    const status = err?.statusCode;
    return { ok: false, gone: status === 404 || status === 410 };
  }
}
