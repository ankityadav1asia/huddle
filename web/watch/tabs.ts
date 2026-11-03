// Swipeable tabs: a tab bar over panels laid side by side in a horizontal scroll-snap pager. A tap or an arrow key on
// a tab scrolls the pager to its panel; a swipe across the panels moves the selected tab as soon as the next panel is
// more than half in view. The room's Chat and match tabs use it.
import { el } from './ui.ts';

export interface SwipeTabs {
  tablist: HTMLDivElement;
  pager: HTMLDivElement;
  tabs: HTMLButtonElement[];
  active(): number;
  select(i: number): void;
  destroy(): void;
}

let ids = 0;

// One panel per name, made by the caller; each becomes its tab's tabpanel. onChange runs when another tab becomes the
// selected one, by a tap, a key or a swipe.
export function swipeTabs(label: string, names: string[], panels: HTMLElement[], onChange: (i: number) => void): SwipeTabs {
  const uid = `tabs${++ids}`;
  let active = 0;
  let target: number | null = null; // the panel a tapped tab is scrolling to
  let moved = false; // whether the pager has scrolled since that tap
  let tappedAt = 0;
  let settleTimer = 0;
  let width = 0;

  const tabs = names.map((name, i) => el('button', {
    type: 'button', class: 'mc-tab', role: 'tab', id: `${uid}-tab-${i}`, 'aria-controls': `${uid}-panel-${i}`, text: name,
    onclick: () => select(i),
  }));
  panels.forEach((p, i) => {
    p.id = `${uid}-panel-${i}`;
    p.setAttribute('role', 'tabpanel');
    p.setAttribute('aria-labelledby', `${uid}-tab-${i}`);
    p.tabIndex = 0;
  });
  const tablist = el('div', { class: 'mc-tabs', role: 'tablist', 'aria-label': label, onkeydown: onTabKey }, tabs);
  const pager = el('div', { class: 'mc-pager', onscroll: onPagerScroll, onscrollend: settle }, panels);
  // A change of width (rotation, the laptop frame's zoom) keeps the active panel in place; a change of height (the
  // composer coming and going) leaves a swipe alone.
  const resize = new ResizeObserver(() => {
    if (pager.clientWidth === width) return;
    width = pager.clientWidth;
    if (target === null) pager.scrollLeft = active * width;
  });
  resize.observe(pager);
  mark(0);

  return { tablist, pager, tabs, active: () => active, select, destroy };

  function destroy() {
    clearTimeout(settleTimer);
    resize.disconnect();
  }

  // The active tab: selected, in the tab order, and the only panel that is not inert (so Tab and screen readers stay
  // in the panel on screen).
  function mark(i: number) {
    const was = active;
    const moveFocus = was !== i && Boolean(panels[was]?.contains(document.activeElement));
    active = i;
    tabs.forEach((t, k) => {
      t.setAttribute('aria-selected', String(k === i));
      t.tabIndex = k === i ? 0 : -1;
    });
    panels.forEach((p, k) => { p.inert = k !== i; });
    if (moveFocus) panels[i].focus({ preventScroll: true });
    const tab = tabs[i];
    if (tab) {
      const left = tab.offsetLeft;
      const right = left + tab.offsetWidth;
      if (left < tablist.scrollLeft) tablist.scrollLeft = left;
      else if (right > tablist.scrollLeft + tablist.clientWidth) tablist.scrollLeft = right - tablist.clientWidth;
    }
    if (was !== i) onChange(i);
  }

  // A tap or key on a tab scrolls the pager to its panel; the scroll then keeps quiet until it gets there.
  function select(i: number) {
    mark(i);
    const w = Math.max(1, pager.clientWidth);
    if (Math.abs(pager.scrollLeft / w - i) < 0.01) {
      target = null;
      return;
    }
    target = i;
    moved = false;
    tappedAt = Date.now();
    const still = document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches;
    pager.scrollTo({ left: i * w, behavior: still ? 'auto' : 'smooth' });
    armSettle();
  }

  function onPagerScroll() {
    const at = pager.scrollLeft / Math.max(1, pager.clientWidth);
    if (target === null) {
      const i = clampIndex(Math.round(at));
      if (i !== active) mark(i);
    } else if (Math.abs(at - target) < 0.01) {
      target = null;
    } else {
      moved = true;
    }
    armSettle();
  }

  // scrollend, or a quiet spell where it is not supported, settles on the nearest panel; a tapped tab's smooth
  // scroll gets longer, so a slow frame does not flick the tabs back.
  function armSettle() {
    clearTimeout(settleTimer);
    settleTimer = window.setTimeout(settle, target === null ? 160 : 700);
  }

  function settle() {
    clearTimeout(settleTimer);
    const at = pager.scrollLeft / Math.max(1, pager.clientWidth);
    // A tapped tab's scroll that has not begun (no frames yet, as in a background tab) is still on its way; a swipe
    // that cut into it wins.
    if (target !== null && Math.abs(at - target) >= 0.01 && !moved && Date.now() - tappedAt < 3000) {
      armSettle();
      return;
    }
    target = null;
    const i = clampIndex(Math.round(at));
    if (i !== active) mark(i);
  }

  function clampIndex(i: number) {
    return Math.max(0, Math.min(tabs.length - 1, i));
  }

  function onTabKey(e: KeyboardEvent) {
    const n = tabs.length;
    const from = tabs.findIndex((t) => t === e.target);
    const at = from < 0 ? active : from;
    const next = e.key === 'ArrowRight' ? (at + 1) % n : e.key === 'ArrowLeft' ? (at - 1 + n) % n
      : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    select(next);
    tabs[next].focus();
  }
}
