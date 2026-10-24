// Syntax highlighting for the Banan editor.
//
// One pass over the source produces HTML spans; the editor shows it in a <pre> behind a textarea
// whose text is transparent, so typing, selection, undo and IME stay native. It understands what
// a Banan contains: the // ==Banan== header and its @tags, template literals with nested ${…}
// expressions, regex literals, and Il2Cpp type names (coloured when the game has that type).

const KEYWORDS = new Set(('break case catch class const continue debugger default delete do else export extends finally for '
  + 'function if import in instanceof let new return static switch throw try typeof var void while with yield async await of get set').split(' '));
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);
const SELF = new Set(['this', 'super']);
const SCOPE = new Set(['Banan', 'BananPlugin', 'BananaLoader', 'Il2Cpp', 'logger', 'module', 'exports', 'Ref', 'console', 'Math', 'JSON', 'Object', 'Array', 'Promise', 'window', 'document']);
const LIFECYCLE = /^on[A-Z]\w*$/;
// a `/` after one of these starts a regex; after anything else it's division
const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '=>', 'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', '']);

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// pieces are [class, text]; class '' is plain text
const span = (cls, s) => [cls, s];

function render(pieces) {
  let html = '';
  let cur = null;
  let buf = '';
  const flush = () => { if (buf) html += cur ? `<span class="h-${cur}">${esc(buf)}</span>` : esc(buf); buf = ''; };
  for (const [cls, text] of pieces) {
    if (!text) continue;
    // whitespace joins whatever it sits between, so `a . b` doesn't split a span
    const k = /^\s+$/.test(text) && cur !== null && cur !== 'com' && cur !== 'str' ? cur : cls;
    if (k !== cur) { flush(); cur = k; }
    buf += text;
  }
  flush();
  return html;
}

const isIdStart = (c) => /[A-Za-z_$]/.test(c) || (c > '\x7f' && /\p{L}/u.test(c));
const isIdPart = (c) => /[\w$]/.test(c) || (c > '\x7f' && /[\p{L}\p{Nd}\p{Mn}\p{Mc}]/u.test(c));

/**
 * Source → HTML. `isType(name)` says whether a bare name is a game type (Camera, Vector3, …).
 */
export function highlight(src, isType = () => false) {
  const out = [];
  const n = src.length;
  let i = 0;
  let prev = '';        // last significant token, for regex detection
  let prevWasDot = false;
  const braces = [];    // template literal nesting: depth of `{` inside each ${…}
  let header = false;   // inside // ==Banan== … // ==/Banan==

  const lineComment = () => {
    const j = src.indexOf('\n', i);
    const end = j < 0 ? n : j;
    const text = src.slice(i, end);
    if (/^\/\/\s*==Banan==/.test(text)) header = true;
    if (header) {
      const m = /^(\/\/\s*)(@[\w-]+)(\s+)?(.*)$/.exec(text);
      if (m) out.push(span('com', m[1]), span('tag', m[2]), span('', m[3] || ''), span('tagv', m[4]));
      else out.push(span('hdr', text));
    } else out.push(span('com', text));
    if (/^\/\/\s*==\/Banan==/.test(text)) header = false;
    i = end;
  };

  const stringLit = (q) => {
    let j = i + 1;
    while (j < n) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === q || c === '\n') { if (c === q) j++; break; }
      j++;
    }
    out.push(span('str', src.slice(i, j)));
    i = j;
    prev = 'str';
  };

  // template text up to the closing backtick or the next ${
  const templateText = () => {
    let j = i;
    while (j < n) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '`') { out.push(span('str', src.slice(i, j + 1))); i = j + 1; prev = 'str'; return; }
      if (c === '$' && src[j + 1] === '{') {
        out.push(span('str', src.slice(i, j)), span('tpl', '${'));
        i = j + 2;
        braces.push(0);
        prev = '(';
        return;
      }
      j++;
    }
    out.push(span('str', src.slice(i)));
    i = n;
  };

  const regexLit = () => {
    let j = i + 1;
    let cls = false;
    while (j < n) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '\n') return false;
      if (c === '[') cls = true;
      else if (c === ']') cls = false;
      else if (c === '/' && !cls) { j++; break; }
      j++;
    }
    while (j < n && /[a-z]/.test(src[j])) j++;
    out.push(span('re', src.slice(i, j)));
    i = j;
    prev = 're';
    return true;
  };

  while (i < n) {
    const c = src[i];
    if (c === '\n' || c === ' ' || c === '\t' || c === '\r') {
      let j = i + 1;
      while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\r' || src[j] === '\n')) j++;
      out.push(span('', src.slice(i, j)));
      i = j;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { lineComment(); continue; }
    if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2);
      const end = j < 0 ? n : j + 2;
      const text = src.slice(i, end);
      out.push(span(text.startsWith('/**') ? 'doc' : 'com', text));
      i = end;
      continue;
    }
    if (c === '"' || c === "'") { stringLit(c); prevWasDot = false; continue; }
    if (c === '`') { i++; out.push(span('str', '`')); templateText(); prevWasDot = false; continue; }
    if (c === '}' && braces.length && braces[braces.length - 1] === 0) {
      braces.pop();
      out.push(span('tpl', '}'));
      i++;
      templateText();
      continue;
    }
    if (c === '/' && REGEX_AFTER.has(prev) && regexLit()) { prevWasDot = false; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) j++;
      out.push(span('num', src.slice(i, j)));
      i = j;
      prev = 'num';
      prevWasDot = false;
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(src[j])) j++;
      const w = src.slice(i, j);
      let k = j;
      while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
      const call = src[k] === '(';
      let cls;
      if (prevWasDot) cls = call ? 'mcall' : 'prop';
      else if (KEYWORDS.has(w)) cls = 'kw';
      else if (LITERALS.has(w)) cls = 'lit';
      else if (SELF.has(w)) cls = 'self';
      else if (prev === 'class' || prev === 'extends' || prev === 'new') cls = 'type';
      else if (SCOPE.has(w)) cls = 'glob';
      else if (/^[A-Z]/.test(w) && isType(w)) cls = 'type';
      else if (call) cls = LIFECYCLE.test(w) ? 'life' : 'fn';
      else cls = 'id';
      out.push(span(cls === 'id' ? '' : cls, w));
      i = j;
      prev = KEYWORDS.has(w) || LITERALS.has(w) ? w : 'id';
      prevWasDot = false;
      continue;
    }
    // punctuation and operators
    if (c === '=' && src[i + 1] === '>') { out.push(span('op', '=>')); i += 2; prev = '=>'; prevWasDot = false; continue; }
    if (c === '?' && src[i + 1] === '.') { out.push(span('pun', '?.')); i += 2; prev = '.'; prevWasDot = true; continue; }
    if (braces.length) {
      if (c === '{') braces[braces.length - 1]++;
      else if (c === '}') braces[braces.length - 1]--;
    }
    out.push(span(/[{}()[\];,.]/.test(c) ? 'pun' : 'op', c));
    prevWasDot = c === '.';
    prev = c === ')' || c === ']' ? 'id' : c;
    i++;
  }
  return render(out);
}
