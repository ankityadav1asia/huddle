// Bottom sheets (dialogs). One open at a time; Escape and the backdrop close it; focus returns to the opener.
import { el } from './ui.ts';

let token = 0;
let dismissable = true;
let opener: (Element & { focus?: () => void }) | null = null; // not every Element has focus()
let onClose: (() => void) | null = null;

// index.html always has the sheet layer, its backdrop and the sheet; nothing here works without them.
const layer = () => document.getElementById('sheet-layer')!;
const sheet = () => document.getElementById('sheet')!;

export function initSheets() {
  layer().querySelector('[data-close]')!.addEventListener('click', () => { if (dismissable) closeSheet(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !layer().hidden && dismissable) closeSheet();
  });
}

type SheetOptions = { title?: string; lede?: string; closable?: boolean; onclose?: (() => void) | null };

// Returns { body, token, isOpen() } — check isOpen() after awaits before writing into the sheet.
export function openSheet({ title, lede, closable = true, onclose = null }: SheetOptions = {}) {
  token += 1;
  const mine = token;
  dismissable = closable;
  opener = document.activeElement;
  onClose = onclose;
  const s = sheet();
  s.replaceChildren();
  const id = `sheet-title-${mine}`;
  s.setAttribute('aria-labelledby', id);
  if (title) s.append(el('h2', { id, text: title }));
  if (lede) s.append(el('p', { class: 'lede', text: lede }));
  const body = el('div', { class: 'sheet-body' });
  s.append(body);
  layer().hidden = false;
  s.scrollTop = 0;
  // Focus the first text field for forms; otherwise the dialog itself, without scrolling it.
  requestAnimationFrame(() => {
    const first = s.querySelector<HTMLElement>('input:not([type="checkbox"]):not([type="radio"]), textarea, select');
    if (first) first.focus();
    else s.focus({ preventScroll: true });
  });
  return { body, token: mine, isOpen: () => token === mine && !layer().hidden };
}

export function closeSheet() {
  token += 1;
  layer().hidden = true;
  sheet().replaceChildren();
  const cb = onClose;
  onClose = null;
  if (cb) cb();
  if (opener && document.contains(opener)) opener.focus?.();
  opener = null;
}

export function sheetActions(...buttons: HTMLElement[]) {
  return el('div', { class: 'sheet-actions' }, buttons);
}

export function confirmSheet({ title, text, confirmLabel, danger = false }: { title: string; text: string; confirmLabel: string; danger?: boolean }) {
  return new Promise<boolean>((resolve) => {
    let answered = false;
    const s = openSheet({ title, onclose: () => { if (!answered) resolve(false); } });
    s.body.append(
      el('p', { class: 'lede', text }),
      sheetActions(
        el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => { answered = true; closeSheet(); resolve(false); } }),
        el('button', { type: 'button', class: `btn primary${danger ? ' danger' : ''}`, text: confirmLabel, onclick: () => { answered = true; closeSheet(); resolve(true); } }),
      ),
    );
  });
}
