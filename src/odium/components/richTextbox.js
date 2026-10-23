import { el } from '../utils/dom.js';
import { Icons } from '../icons.js';

const TOOLS = [
  ['B', 'bold'],
  ['I', 'italic'],
  ['U', 'underline'],
  ['S', 'strikeThrough'],
  [Icons.list, 'insertUnorderedList', 'Bullet list'],
  [Icons.eraser, 'removeFormat', 'Clear formatting'],
];

/** contenteditable editor with a tiny formatting toolbar. Action receives (html, plainText). */
export function createRichTextbox(text, action, o = {}) {
  const n = el('div', 'card');
  const l = el('span', 'lbl');
  l.textContent = text;
  const bar = el('div', 'rt-bar');
  const area = el('div', 'rt-area');
  area.contentEditable = 'true';
  area.dataset.ph = o.placeholder || 'Type here…';
  if (o.value) area.innerHTML = o.value;
  const c = this._ctl(n);
  const fire = () => c._out(action, area.innerHTML, area.innerText);

  TOOLS.forEach(([t, cmd, title]) => {
    const b = el('button', 'rt-b');
    if (t.startsWith('<svg')) b.innerHTML = t; else b.textContent = t;
    b.title = title || cmd;
    if (cmd === 'italic') b.style.fontStyle = 'italic';
    if (cmd === 'underline') b.style.textDecoration = 'underline';
    if (cmd === 'strikeThrough') b.style.textDecoration = 'line-through';
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => { area.focus(); document.execCommand(cmd, false, null); fire(); };
    bar.appendChild(b);
  });

  area.oninput = fire;
  n.append(l, bar, area);

  c.getValue = () => area.innerHTML;
  c.setValue = (h, silent) => { area.innerHTML = h ?? ''; if (!silent) fire(); return c; };
  c.getHTML = () => area.innerHTML;
  c.getText = () => area.innerText;
  c.setHTML = (h) => { area.innerHTML = h; return c; };
  c.clear = () => { area.innerHTML = ''; return c; };
  return this._reg(c, text, o);
}
