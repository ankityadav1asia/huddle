// Huddle Watch Party: boot and hash routing (#/ home, #/room/<id>).
import { api } from './api.ts';
import { el, fitPhone, setRail, railIntro } from './ui.ts';
import { initSheets, closeSheet } from './sheets.ts';
import { renderAuth, renderProfile } from './auth.ts';
import { renderHome, leaveHome } from './home.ts';
import { renderRoom, leaveRoom } from './room.ts';

// What every view gets: the server config and the signed-in user (JSON from the API), and navigation.
export interface Ctx {
  config: any;
  me: any;
  needsProfile?: boolean;
  navigate(hash: string): void;
  signedIn(user: any, needsProfile: boolean): void;
  signedOut(): void;
  editProfile(): void;
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

let routing = 0;

async function route() {
  const mine = ++routing;
  leaveRoom();
  leaveHome();
  closeSheet();
  if (!ctx.me) {
    try {
      const r = await api.get('/api/me');
      ctx.me = r.user;
      ctx.needsProfile = r.needs_profile;
    } catch (err) {
      if (mine !== routing) return;
      if (err.status === 401) return renderAuth(ctx);
      return renderFailure(err.message);
    }
  }
  if (mine !== routing) return;
  if (ctx.needsProfile || !ctx.me.handle) return renderProfile(ctx);
  const m = location.hash.match(/^#\/room\/(room_[a-f0-9]{20})$/);
  if (m) return renderRoom(ctx, m[1]);
  return renderHome(ctx);
}

function renderFailure(message) {
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
  try {
    ctx.config = await api.get('/api/config');
  } catch (err) {
    renderFailure(err.message);
    return;
  }
  addEventListener('hashchange', route);
  // A notification click on an already-open tab asks the page to navigate.
  navigator.serviceWorker?.addEventListener?.('message', (e) => {
    if (e.data?.type === 'open' && typeof e.data.url === 'string' && e.data.url.startsWith('/')) location.href = e.data.url;
  });
  await route();
}

boot();
