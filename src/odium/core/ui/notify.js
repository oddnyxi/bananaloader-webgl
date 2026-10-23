import { el } from '../../utils/dom.js';

/** Toast. notify(text, type = 'info' | 'success' | 'warn' | 'error', ms = 2500). */
export function notify(text, type = 'info', ms = 2500) {
  if (typeof type === 'number') { ms = type; type = 'info'; }
  if (!this.toasts) return;
  const t = el('div', 'toast ' + type);
  t.textContent = text;
  this.toasts.appendChild(t);
  setTimeout(() => t.remove(), ms);
}
