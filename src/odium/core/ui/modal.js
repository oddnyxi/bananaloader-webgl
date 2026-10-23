import { el } from '../../utils/dom.js';

/** Low-level modal. buttons: [{ text, value | () => value, primary?, cancel? }]. Resolves with the clicked value. */
export function _modal(title, body, buttons) {
  return new Promise((resolve) => {
    const back = el('div', 'modal-back');
    const m = el('div', 'modal');
    const h = el('div', 'm-title');
    h.textContent = title;
    const foot = el('div', 'm-foot');
    m.append(h, body, foot);
    back.appendChild(m);
    this.root.appendChild(back);

    const close = (v) => { back.remove(); resolve(v); };
    buttons.forEach((b) => {
      const x = el('button', 'btn' + (b.primary ? ' primary' : ''));
      x.textContent = b.text;
      x.onclick = () => close(typeof b.value === 'function' ? b.value() : b.value);
      foot.appendChild(x);
    });
    // clicking the backdrop behaves like the cancel button
    back.onclick = (e) => { if (e.target === back) close(buttons.find((b) => b.cancel)?.value ?? null); };
  });
}

/** Resolves true / false. */
export function confirm(message, o = {}) {
  const body = el('div', 'm-text');
  body.textContent = message;
  return this._modal(o.title || 'Confirm', body, [
    { text: o.no || 'Cancel', value: false, cancel: true },
    { text: o.yes || 'Confirm', value: true, primary: true },
  ]);
}

/** Resolves true. */
export function alert(message, o = {}) {
  const body = el('div', 'm-text');
  body.textContent = message;
  return this._modal(o.title || 'Notice', body, [{ text: o.ok || 'OK', value: true, primary: true, cancel: true }]);
}

/** Resolves the entered string, or null when cancelled. Pass { multiline: true } for a textarea. */
export function prompt(message, o = {}) {
  const body = el('div');
  const t = el('div', 'm-text');
  t.textContent = message;
  const i = el(o.multiline ? 'textarea' : 'input', 'in');
  if (!o.multiline) i.type = 'text';
  i.placeholder = o.placeholder || '';
  i.value = o.value || '';
  body.append(t, i);
  setTimeout(() => i.focus(), 30);
  return this._modal(o.title || 'Input', body, [
    { text: 'Cancel', value: null, cancel: true },
    { text: o.ok || 'OK', value: () => i.value, primary: true },
  ]);
}
