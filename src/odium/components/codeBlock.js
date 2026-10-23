import { el } from '../utils/dom.js';
import { copyText } from '../utils/clipboard.js';

export function createCodeBlock(code, o = {}) {
  const n = el('div', 'card');
  const row = el('div', 'row');
  const l = el('span', 'lbl');
  l.textContent = o.title || 'Code';
  const cp = el('button', 'mini');
  cp.textContent = 'Copy';
  row.append(l, cp);
  const pre = el('pre', 'code');
  pre.textContent = code;
  n.append(row, pre);
  const c = this._ctl(n);

  cp.onclick = async () => {
    const ok = await copyText(pre.textContent);
    cp.textContent = ok ? 'Copied' : 'Failed';
    setTimeout(() => { cp.textContent = 'Copy'; }, 1200);
  };

  c.setCode = (x) => { pre.textContent = x; return c; };
  c.getValue = () => pre.textContent;
  return c;
}
