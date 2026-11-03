// DOM helpers. User-supplied text only ever goes through textContent; innerHTML is used for the fixed icon
// SVG strings below and nothing else.

// Children of el(): nodes and text, in arrays nested up to three deep. null, undefined and false are skipped.
export type Child = Node | string | number | false | null | undefined | readonly Child[];

// Attributes of el(); null, undefined and false are skipped. class, text and dataset are special. on<event> handlers
// listen on the node, so currentTarget is the node (until an await). Booleans and numbers set properties (hidden,
// disabled, checked), so aria-* values must be strings. Anything else is an attribute.
type Listeners<T> = { [E in keyof HTMLElementEventMap as `on${E}`]?: (event: HTMLElementEventMap[E] & { currentTarget: T }) => unknown };
export type Attrs<T extends HTMLElement = HTMLElement> = Listeners<T> & {
  class?: string | null;
  text?: string | number | null;
  dataset?: Record<string, string>;
  [aria: `aria-${string}`]: string | null | undefined;
  [attr: string]: unknown;
};

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Attrs<HTMLElementTagNameMap[K]> | null, ...children: Child[]): HTMLElementTagNameMap[K];
export function el(tag: string, props: Record<string, any> | null = {}, ...children: any[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    // A property the caller names (hidden, disabled, checked); no type guard can check a name, hence the cast.
    else if (typeof v === 'boolean' || typeof v === 'number') (node as HTMLElement & Record<string, unknown>)[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat(3)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : String(c));
  }
  return node;
}

const ICONS = {
  spark: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0l1.9 6.1L16 8l-6.1 1.9L8 16l-1.9-6.1L0 8l6.1-1.9z"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.4 4.6L8 12l7.4 7.4-1.4 1.4L5.2 12 14 3.2z"/></svg>',
  dots: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11.5L21 3l-6.5 18-3.2-7.3z"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.3 5.7L12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>',
  shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5z"/></svg>',
  bat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.6 2.3l2.1 2.1-3.1 3.1.7.7-9.6 9.6a2.2 2.2 0 0 1-3.1 0l-.9-.9a2.2 2.2 0 0 1 0-3.1l9.6-9.6.7.7z"/><circle cx="5" cy="19" r="2.2"/></svg>',
  ball: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 5.5c2 3.6 2 9.4 0 13M16 5.5c-2 3.6-2 9.4 0 13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2 1.6"/></svg>',
  dot: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/></svg>',
  // Dream AI: a chat bubble with an AI sparkle cut out of it.
  ai: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="M7.5 2h9A3.5 3.5 0 0 1 20 5.5v7a3.5 3.5 0 0 1-3.5 3.5h-5.3l-4.5 3.6c-.6.5-1.5.1-1.5-.7V16A3.5 3.5 0 0 1 4 12.5v-7A3.5 3.5 0 0 1 7.5 2zM12 4.6l1.25 3.15L16.4 9l-3.15 1.25L12 13.4l-1.25-3.15L7.6 9l3.15-1.25z"/></svg>',
};

export function icon(name: keyof typeof ICONS) {
  const span = document.createElement('span');
  span.className = `ico ico-${name}`;
  span.innerHTML = ICONS[name];
  return span;
}

export function aiLabel(text: string) {
  const label = el('span', { class: 'ai-label' });
  label.innerHTML = ICONS.spark;
  label.append(text);
  return label;
}

export const initials = (handle: string | null = '') => (String(handle).split(/[^a-z0-9]+/i).filter(Boolean).map((s) => s[0]).join('') || String(handle)).slice(0, 2).toUpperCase();

// Colours for every team a fan can back (and the crowd's sides); styles.css maps t-<code> to them.
const TEAM_COLOURS = new Set(['MI', 'CSK', 'JPP', 'PAT', 'MBSG', 'EBFC', 'GSW', 'LAL']);
export const teamClass = (team: string | null) => (team && TEAM_COLOURS.has(team) ? `team t-${team.toLowerCase()}` : '');

// A team code ('MI'), or a team from the match data, which may carry its own logo.
export function teamLogo(team: string | { code: string; logo?: string }) {
  return el('img', { class: 'logo', src: (typeof team === 'object' && team.logo) || `assets/${String(typeof team === 'object' ? team.code || team : team).toLowerCase()}.png`, alt: '' });
}

export function clock(date: string) {
  const d = new Date(date);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}

export function clockSeconds(date: string) {
  const d = new Date(date);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
}

export function ago(seconds: number | null) {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const s = Math.max(0, Math.round(seconds));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

export function inHours(date: string) {
  const ms = new Date(date).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '';
  const h = Math.round(ms / 3600000);
  return h >= 1 ? `expires in ${h} h` : 'expires soon';
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// One floating message at a time (in-app alerts, errors, confirmations).
let toastTimer = 0;
type ToastOptions = { action?: { label: string; run: () => void }; ms?: number; tone?: string };
export function toast(parts: Child, { action, ms = 6000, tone = '' }: ToastOptions = {}) {
  const box = document.getElementById('toast');
  if (!box) return;
  box.replaceChildren(el('span', {}, parts));
  box.className = `toast${tone ? ` ${tone}` : ''}`;
  if (action) {
    box.append(el('button', { type: 'button', text: action.label, onclick: () => { box.hidden = true; action.run(); } }));
  }
  box.append(el('button', { type: 'button', class: 'x', 'aria-label': 'Dismiss', onclick: () => { box.hidden = true; } }, icon('close')));
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, ms);
}

// On a laptop the app sits in a phone frame; shrink the whole frame on short screens instead of squashing the chat.
export function fitPhone() {
  const phone = document.querySelector<HTMLElement>('.phone');
  if (phone) phone.style.zoom = innerWidth > 520 ? String(Math.min(1, (innerHeight - 32) / 864)) : '';
}

export function setRail(...children: (Node | null | readonly Node[])[]) {
  const rail = document.getElementById('rail');
  if (rail) rail.replaceChildren(...children.flat().filter((c): c is Node => Boolean(c)));
}

export function railIntro() {
  return [
    el('p', { class: 'rail-kicker', text: 'Prototype · Sports watch parties' }),
    el('h1', { class: 'rail-title', text: 'Huddle' }),
    el('p', { class: 'rail-lede', text: 'Watch parties for cricket, kabaddi, football and basketball fans: invite friends, chat in real time and follow the live scorecard, with an AI Co-host in the chat and Dream AI for your own questions.' }),
    el('ul', { class: 'rail-features' },
      el('li', {}, el('b', { text: 'Watch parties' }), el('span', { text: 'A public room for every sport run by Huddle, and private rooms you start in one tap and invite friends to by username.' })),
      el('li', {}, el('b', { text: 'Match Centre' }), el('span', { text: 'The full scorecard, commentary, over by over and graphs sit in tabs beside the chat: swipe across, or tap the scorecard.' })),
      el('li', {}, el('b', { text: 'AI Co-host' }), el('span', { text: 'Posts the big moments and quick polls in the chat, and answers the questions nobody else does. Its messages are labelled as AI.' })),
      el('li', {}, el('b', { text: 'Dream AI' }), el('span', { text: 'Ask the AI anything about the game, its players or its rules. Only you see the answers, which come from verified match data and a checked rules sheet.' })),
      el('li', {}, el('b', { text: 'Safe by default' }), el('span', { text: 'Choose relaxed, balanced or strict moderation. Core safety protections are always on.' }))),
    el('p', { class: 'rail-fine', text: 'Messages disappear when a watch party ends.' }),
  ];
}
