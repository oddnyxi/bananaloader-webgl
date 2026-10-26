// Autocomplete popup for a <textarea>: member lists, type names in strings, and signature help.
//
//   const ac = attachComplete(textarea, { completer: () => app.completer, context: () => ({ roots }) });
//   textarea.addEventListener('keydown', (e) => { if (ac.key(e)) return; … });
//
// Opens by itself after `.`, while typing a name, and inside Il2Cpp.type('…'); Ctrl+Space opens it
// anywhere. ↑/↓ choose, Tab or Enter accept, Esc closes.

const KIND_LABEL = {
  field: ['F', 'field'], prop: ['P', 'property'], method: ['M', 'method'], const: ['C', 'constant'], enum: ['E', 'enum value'],
  class: ['T', 'class'], struct: ['S', 'struct'], interface: ['I', 'interface'], enumtype: ['E', 'enum'], ns: ['N', 'namespace'],
  var: ['v', 'value'], fn: ['ƒ', 'function'], helper: ['$', 'helper'], kw: ['k', 'keyword'],
};

const MAX_ROWS = 10;

export function attachComplete(ta, { completer, context, enabled = () => true }) {
  // the textarea may not be in the document yet: look its root up when it's needed
  const rootNode = () => { const r = ta.getRootNode ? ta.getRootNode() : document; return r && r !== ta ? r : document; };
  const box = document.createElement('div');
  box.className = 'ac';
  box.hidden = true;
  const head = document.createElement('div');
  head.className = 'ac-head';
  const list = document.createElement('div');
  list.className = 'ac-list';
  const foot = document.createElement('div');
  foot.className = 'ac-foot';
  const hintEl = document.createElement('div');
  hintEl.className = 'ac-hint';
  box.append(head, list, foot);
  const hintBox = document.createElement('div');
  hintBox.className = 'ac ac-sig';
  hintBox.hidden = true;
  hintBox.append(hintEl);
  let mounted = false;
  // inside the window's .root so the theme variables (accent colour) apply
  const mount = () => {
    if (mounted) return;
    const r = rootNode();
    (ta.closest('.root') || (r !== document && r.appendChild ? r : document.body)).append(box, hintBox);
    mounted = true;
  };
  // clicks in the popup (its scrollbar, the hint) keep the focus in the textarea
  for (const n of [box, hintBox]) n.addEventListener('mousedown', (e) => e.preventDefault());
  let destroyed = false;

  let state = null; // { from, to, items, sel, hint }
  let manual = false;
  let suppress = false;

  const close = () => { state = null; box.hidden = true; hintBox.hidden = true; manual = false; };

  function compute(force) {
    if (destroyed || !enabled()) { close(); return; }
    const c = completer();
    if (!c) { close(); return; }
    const pos = ta.selectionStart;
    if (pos !== ta.selectionEnd) { close(); return; }
    let r = null;
    try { r = c.complete(ta.value, pos, context() || {}, force || manual); } catch (e) { r = null; console.debug('[complete]', e); }
    if (!r || (!r.items.length && !r.hint)) { close(); return; }
    const prevLabel = state && state.items[state.sel] ? state.items[state.sel].label : null;
    state = { ...r, items: r.items.slice(0, 200), sel: 0, v: ta.value, pos }; // only 200 rows are ever rendered
    if (prevLabel) { const i = r.items.findIndex((x) => x.label === prevLabel); if (i >= 0 && r.prefix) state.sel = i; }
    // a single exact match that's already typed isn't worth a popup
    if (r.items.length === 1 && r.items[0].label === r.prefix && !force) state.items = [];
    render();
  }

  // Synchronous on purpose: a game rendering at a few fps would make rAF-paced updates lag
  // behind the typing (and Enter could accept a list computed for older text).
  function schedule(force = false) { compute(force); }

  function render() {
    mount();
    const st = state;
    if (!st) return;
    const xy = caretXY(ta, st.items.length ? st.from : ta.selectionStart);
    // signature help
    if (st.hint && st.hint.sigs.length) {
      hintEl.replaceChildren(...st.hint.sigs.slice(0, 6).map((g) => sigLine(g, st.hint.active)));
      if (st.hint.sigs.length > 6) hintEl.append(el('div', 'ac-more', `+${st.hint.sigs.length - 6} more overloads`));
      hintBox.hidden = false;
    } else hintBox.hidden = true;
    if (!st.items.length) {
      box.hidden = true;
      if (!hintBox.hidden) place(hintBox, xy, true, true);
      return;
    }
    head.textContent = st.owner ? st.owner : st.string ? 'type names' : '';
    head.hidden = !head.textContent;
    list.replaceChildren();
    const rows = st.items.slice(0, 200);
    rows.forEach((it, i) => {
      const [badge, kname] = KIND_LABEL[it.kind] || ['·', it.kind];
      const row = el('div', `ac-row${i === st.sel ? ' on' : ''}${it.dim ? ' dim' : ''}`);
      row.append(el('span', `ac-k k-${it.kind}`, badge), labelEl(it.label, st.prefix), el('span', 'ac-d', it.detail || kname));
      row.title = it.detail || '';
      row.addEventListener('mousedown', (e) => { e.preventDefault(); state.sel = i; accept(); });
      list.append(row);
    });
    const cur = st.items[st.sel];
    foot.textContent = cur ? `${(KIND_LABEL[cur.kind] || ['', cur.kind])[1]}${cur.inherited ? ' (inherited)' : ''} · ${cur.detail || cur.label}` : '';
    foot.hidden = !cur;
    box.hidden = false;
    const onRow = list.children[st.sel];
    place(box, xy, false);
    if (onRow) {
      const top = onRow.offsetTop;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (top + onRow.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + onRow.offsetHeight - list.clientHeight;
    }
    if (!hintBox.hidden) {
      // signature help sits on the other side of the caret
      const r = box.getBoundingClientRect();
      const below = r.top > xy.y;
      hintBox.style.left = `${Math.round(r.left)}px`;
      hintBox.style.top = below ? `${Math.round(xy.y - xy.h - hintBox.offsetHeight - 4)}px` : `${Math.round(xy.y + 4)}px`;
    }
  }

  function place(node, xy, small, preferAbove = false) {
    // keep inside the tool window (its root clips) and the viewport
    const win = ta.closest('.win, .pwin');
    const wr = win ? win.getBoundingClientRect() : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    const L = Math.max(0, wr.left), Tp = Math.max(0, wr.top);
    const R = Math.min(window.innerWidth, wr.right), B = Math.min(window.innerHeight, wr.bottom);
    node.style.left = '0px';
    node.style.top = '0px';
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    let x = Math.min(xy.x - (small ? 0 : 22), R - w - 6);
    x = Math.max(L + 6, x);
    const below = xy.y + 2;
    const above = xy.y - xy.h - h - 4;
    const fitsBelow = below + h <= B - 6;
    const fitsAbove = above >= Tp + 6;
    const y = preferAbove ? (fitsAbove || !fitsBelow ? above : below) : (fitsBelow || !fitsAbove ? below : above);
    node.style.left = `${Math.round(x)}px`;
    node.style.top = `${Math.round(y)}px`;
  }

  function accept() {
    const st = state;
    if (!st || !st.items.length) return false;
    const it = st.items[st.sel];
    if (!it) return false;
    const ins = it.insert || it.label;
    const close2 = it.close || '';
    const after = ta.value.slice(st.to);
    // don't double up a closing ) or ') that's already there, unless it belongs to an outer call:
    // Debug.Log(go.Get|) keeps Log's ) and adds GetComponent's own
    let skipClose = false;
    if (close2 && after.startsWith(close2)) skipClose = !close2.endsWith(')') || !unclosed(ta.value.slice(0, st.from), '(', ')');
    const text = ins + (skipClose ? '' : close2);
    suppress = true;
    ta.focus();
    ta.setRangeText(text, st.from, st.to, 'end');
    const caret = st.from + ins.length + (it.caretAfterClose ? close2.length : 0);
    ta.setSelectionRange(caret, caret);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    suppress = false;
    close();
    if (/[.(<'"]$/.test(ins)) schedule(false);
    return true;
  }

  function move(d) {
    if (!state || !state.items.length) return;
    const n = Math.min(state.items.length, 200);
    state.sel = (((state.sel + d) % n) + n) % n;
    render();
  }

  ta.addEventListener('input', (e) => {
    if (suppress || destroyed) return;
    const pos = ta.selectionStart;
    const ch = ta.value[pos - 1] || '';
    const typed = e.inputType && e.inputType.startsWith('insert');
    if (state || manual || (typed && /[\w$.('"<,]/.test(ch))) schedule(false);
    else close();
  });
  ta.addEventListener('blur', () => setTimeout(() => { const r = rootNode(); if (r.activeElement !== ta && document.activeElement !== ta) close(); }, 120));
  ta.addEventListener('click', () => { if (state) schedule(false); });
  ta.addEventListener('scroll', () => { if (state) render(); });

  return {
    /** Call first from the textarea's keydown handler; returns true when the key was used. */
    key(e) {
      if (destroyed) return false;
      if ((e.ctrlKey || e.metaKey) && (e.key === ' ' || e.code === 'Space')) { e.preventDefault(); manual = true; compute(true); return true; }
      if (!state) return false;
      if (state.v !== ta.value || state.pos !== ta.selectionStart) compute(false); // stale: text changed under us
      if (!state) return false;
      const open = state.items.length > 0;
      switch (e.key) {
        case 'Escape': e.preventDefault(); e.stopPropagation(); close(); return true;
        case 'ArrowDown': if (!open) return false; e.preventDefault(); move(1); return true;
        case 'ArrowUp': if (!open) return false; e.preventDefault(); move(-1); return true;
        case 'PageDown': if (!open) return false; e.preventDefault(); move(MAX_ROWS - 1); return true;
        case 'PageUp': if (!open) return false; e.preventDefault(); move(-(MAX_ROWS - 1)); return true;
        case 'Tab': if (!open || e.shiftKey) return false; e.preventDefault(); return accept();
        case 'Enter': if (!open || e.shiftKey || e.ctrlKey || e.metaKey) return false; e.preventDefault(); return accept();
        case 'ArrowLeft': case 'ArrowRight': case 'Home': case 'End': schedule(false); return false;
        default: return false;
      }
    },
    close,
    refresh: () => schedule(false),
    get open() { return !!(state && state.items.length); },
    get state() { return state && { from: state.from, to: state.to, prefix: state.prefix, sel: state.sel, items: state.items.slice(0, 5).map((x) => x.label), hint: !!state.hint }; },
    destroy() { destroyed = true; close(); box.remove(); hintBox.remove(); mounted = false; },
  };
}

/** Is there an `open` bracket in `text` that no `close` matches? (strings skipped, roughly) */
function unclosed(text, open, close) {
  let depth = 0;
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === open) depth++;
    else if (c === close && depth > 0) depth--;
  }
  return depth > 0;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function labelEl(label, prefix) {
  const n = el('span', 'ac-l');
  const p = prefix ? label.toLowerCase().indexOf(prefix.toLowerCase()) : -1;
  if (p >= 0 && prefix) {
    n.append(label.slice(0, p), el('b', '', label.slice(p, p + prefix.length)), label.slice(p + prefix.length));
  } else n.textContent = label;
  return n;
}

function sigLine(g, active) {
  const row = el('div', 'ac-sigrow');
  row.append(el('span', 'ac-ret', `${g.ret} `));
  const name = g.text.slice(0, g.text.indexOf('('));
  row.append(el('span', 'ac-fn', name), '(');
  g.params.forEach((p, i) => {
    if (i) row.append(', ');
    row.append(el(i === active ? 'b' : 'span', i === active ? 'ac-on' : '', p));
  });
  row.append(')');
  return row;
}

// ------------------------------------------------------------------------------------ caret position

const COPY = ['boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'lineHeight', 'fontFamily', 'textAlign', 'textTransform', 'textIndent', 'letterSpacing', 'wordSpacing', 'tabSize'];

let mirror = null;

/** Viewport position of character `pos` in a textarea: { x, y (bottom of the line), h }. */
export function caretXY(ta, pos) {
  const cs = getComputedStyle(ta);
  const root = ta.getRootNode && ta.getRootNode() !== document ? ta.getRootNode() : document.body;
  if (!mirror || mirror.getRootNode() !== root) {
    if (mirror) mirror.remove();
    mirror = document.createElement('div');
    mirror.setAttribute('aria-hidden', 'true');
    (root.appendChild ? root : document.body).appendChild(mirror);
  }
  const s = mirror.style;
  s.position = 'fixed';
  s.visibility = 'hidden';
  s.left = '-9999px';
  s.top = '0';
  s.overflow = 'hidden';
  s.height = 'auto';
  for (const k of COPY) s[k] = cs[k];
  const wrapOff = ta.getAttribute('wrap') === 'off' || cs.whiteSpace === 'pre';
  s.whiteSpace = wrapOff ? 'pre' : 'pre-wrap';
  s.overflowWrap = wrapOff ? 'normal' : 'break-word';
  if (wrapOff) s.width = 'auto';
  mirror.textContent = ta.value.slice(0, pos);
  const mark = document.createElement('span');
  mark.textContent = ta.value.slice(pos, pos + 1) || '.';
  mirror.appendChild(mark);
  const r = ta.getBoundingClientRect();
  const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4 || 16;
  const x = r.left + ta.clientLeft + mark.offsetLeft - ta.scrollLeft;
  const top = r.top + ta.clientTop + mark.offsetTop - ta.scrollTop;
  return { x: Math.max(r.left, Math.min(r.right, x)), y: Math.min(r.bottom, Math.max(r.top + lh, top + lh)), h: lh };
}
