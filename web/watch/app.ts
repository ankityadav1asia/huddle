// Huddle Watch Party: boot and hash routing (#/ home, #/room/<id>).
import { api, ApiError, errorMessage, type Config, type Me, type MeResponse } from './api.ts';
import { el, fitPhone, setRail, railIntro } from './ui.ts';
import { initSheets, closeSheet } from './sheets.ts';
import { renderAuth, renderProfile } from './auth.ts';
import { renderHome, leaveHome } from './home.ts';
import { renderRoom, leaveRoom } from './room.ts';

// What every view gets: the server config, the signed-in user and navigation. config is null until boot() has
// loaded it, and me while nobody is signed in.
export interface Ctx {
  config: Config | null;
  me: Me | null;
  needsProfile?: boolean;
  navigate(hash: string): void;
  signedIn(user: Me, needsProfile: boolean): void;
  signedOut(): void;
  editProfile(): void;
}

// What home and rooms get: route() only renders them with the config loaded and a user who has a handle.
export interface ReadyCtx extends Ctx {
  config: Config;
  me: Me & { handle: string };
}

const ctx: Ctx = {
  config: null,
  me: null,
  navigate(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  },
  signedIn(user, needsProfile) {
    ctx.me = user;
    ctx.needsProfile = needsProfile;
    route();
  },
  signedOut() {
    ctx.me = null;
    leaveRoom();
    leaveHome();
    closeSheet();
    renderAuth(ctx);
  },
  editProfile() {
    leaveRoom();
    leaveHome();
    renderProfile(ctx);
  },
};

// boot() loads the config before any route(), so in effect this checks for a handle: no handle, no home or rooms.
const isReady = (c: Ctx): c is ReadyCtx => c.config !== null && Boolean(c.me?.handle);

let routing = 0;

async function route() {
  const mine = ++routing;
  leaveRoom();
  leaveHome();
  closeSheet();
  if (!ctx.me) {
    try {
      const r: MeResponse = await api.get('/api/me');
      ctx.me = r.user;
      ctx.needsProfile = r.needs_profile;
    } catch (err) {
      if (mine !== routing) return;
      if (err instanceof ApiError && err.status === 401) return renderAuth(ctx);
      return renderFailure(errorMessage(err));
    }
  }
  if (mine !== routing) return;
  if (ctx.needsProfile || !isReady(ctx)) return renderProfile(ctx);
  const m = location.hash.match(/^#\/room\/(room_[a-f0-9]{20})$/);
  if (m) return renderRoom(ctx, m[1]);
  return renderHome(ctx);
}

function renderFailure(message: string) {
  setRail(railIntro());
  document.getElementById('view')?.replaceChildren(
    el('div', { class: 'masthead' }, el('header', { class: 'top' }, el('div', { class: 'top-title' }, el('b', { class: 'brand', text: 'Huddle' })))),
    el('div', { class: 'scroll-body' }, el('div', { class: 'card ended-card' },
      el('h2', { class: 'card-title', text: 'Huddle is not available right now' }),
      el('p', { class: 'card-lede', text: message }),
      el('button', { type: 'button', class: 'btn primary', text: 'Try again', onclick: () => location.reload() }))),
  );
}

async function boot() {
  fitPhone();
  addEventListener('resize', fitPhone);
  initSheets();
  dropServiceWorker();
  try {
    ctx.config = await api.get('/api/config');
  } catch (err) {
    renderFailure(errorMessage(err));
    return;
  }
  addEventListener('hashchange', route);
  await route();
}

// Push alerts are gone: unregister the service worker an earlier version registered for them.
function dropServiceWorker() {
  try {
    navigator.serviceWorker?.getRegistrations().then((regs) => Promise.all(regs.map((r) => r.unregister()))).catch(() => {});
  } catch { /* no service worker access on this page (insecure or sandboxed) */ }
}

boot();
