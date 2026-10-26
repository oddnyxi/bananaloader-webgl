// BananaLogger: per-Banan loggers feeding the loader console (and the browser console).

export class LogHub {
  constructor() {
    this.lines = [];
    this.listeners = [];
    this.max = 2000;
  }

  push(line) {
    this.lines.push(line);
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
    for (const fn of this.listeners) { try { fn(line); } catch (_) { /* ignore */ } }
  }

  on(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((x) => x !== fn); }; }

  logger(source, color = '#e11d2e') { return new Logger(this, source, color); }
}

const CONSOLE = { msg: 'log', warning: 'warn', error: 'error', success: 'log', debug: 'debug', big: 'log' };

export class Logger {
  constructor(hub, source, color) {
    this.hub = hub;
    this.source = source;
    this.color = color;
  }

  _write(level, args) {
    const text = args.map((a) => safeJson(a)).join(' ');
    const line = { time: new Date(), level, source: this.source, color: this.color, text };
    this.hub.push(line);
    const fn = console[CONSOLE[level]] || console.log;
    fn.call(console, `%c[${this.source}]%c ${text}`, `color:${this.color};font-weight:bold`, '');
  }

  msg(...a) { this._write('msg', a); }
  log(...a) { this._write('msg', a); }
  warning(...a) { this._write('warning', a); }
  warn(...a) { this._write('warning', a); }
  error(...a) { this._write('error', a); }
  success(...a) { this._write('success', a); }
  debug(...a) { this._write('debug', a); }
  /** A banner line, like MelonLogger.BigError / the startup header. */
  big(...a) { this._write('big', a); }
}

const FN_TO_STRING = Function.prototype.toString;
const OBJ_TO_STRING = Object.prototype.toString;

/** Readable text for any value: never throws, handles cycles, Maps, Sets, NaN, BigInt and Il2Cpp proxies. */
export function safeJson(v) {
  try { return show(v, 0, new Set(), true); } catch (_) { try { return String(v); } catch (__) { return '[unprintable]'; } }
}

function show(v, depth, seen, top = false) {
  switch (typeof v) {
    case 'string': return top ? v : JSON.stringify(v);
    case 'number': return Object.is(v, -0) ? '-0' : String(v);
    case 'bigint': return v.toString() + 'n';
    case 'undefined': return 'undefined';
    case 'boolean': return String(v);
    case 'symbol': return v.toString();
    case 'function': {
      // Il2Cpp type proxies are functions with their own toString; don't touch anything else on them
      let ts;
      try { ts = v.toString; } catch (_) { ts = null; }
      if (typeof ts === 'function' && ts !== FN_TO_STRING) { try { return String(ts.call(v)); } catch (_) { /* fall through */ } }
      let name = '';
      try { name = FN_TO_STRING.call(v).startsWith('class') ? `[class ${v.name || 'anonymous'}]` : ''; } catch (_) { return '[Function]'; }
      return name || `[Function ${v.name || 'anonymous'}]`;
    }
    default: break;
  }
  if (v === null) return 'null';
  if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
  if (seen.has(v)) return '[Circular]';
  if (depth > 3) return Array.isArray(v) ? '[Array]' : '[Object]';
  seen.add(v);
  try {
    if (Array.isArray(v)) {
      const items = v.slice(0, 100).map((x) => show(x, depth + 1, seen));
      if (v.length > 100) items.push(`… ${v.length - 100} more`);
      return `[${items.join(', ')}]`;
    }
    if (v instanceof Map) {
      const items = [...v].slice(0, 50).map(([k, x]) => `${show(k, depth + 1, seen)} => ${show(x, depth + 1, seen)}`);
      return `Map(${v.size}) {${items.length ? ' ' + items.join(', ') + (v.size > 50 ? ', …' : '') + ' ' : ''}}`;
    }
    if (v instanceof Set) {
      const items = [...v].slice(0, 50).map((x) => show(x, depth + 1, seen));
      return `Set(${v.size}) {${items.length ? ' ' + items.join(', ') + (v.size > 50 ? ', …' : '') + ' ' : ''}}`;
    }
    if (v instanceof Date) return isNaN(v) ? 'Invalid Date' : v.toISOString();
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
      const items = Array.from(v.subarray(0, 20), (x) => show(x, depth + 1, seen));
      return `${v.constructor.name}(${v.length}) [${items.join(', ')}${v.length > 20 ? ', …' : ''}]`;
    }
    if (typeof Promise !== 'undefined' && v instanceof Promise) return 'Promise';
    // objects with their own toString (Il2Cpp object proxies, classes)
    let ts;
    try { ts = v.toString; } catch (_) { ts = null; }
    if (typeof ts === 'function' && ts !== OBJ_TO_STRING) { try { const r = ts.call(v); if (typeof r === 'string') return r; } catch (_) { /* fall through */ } }
    let tj;
    try { tj = v.toJSON; } catch (_) { tj = null; }
    if (typeof tj === 'function') { try { return show(tj.call(v), depth, seen); } catch (_) { /* fall through */ } }
    const keys = Object.keys(v);
    const items = keys.slice(0, 50).map((k) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${show(v[k], depth + 1, seen)}`);
    if (keys.length > 50) items.push(`… ${keys.length - 50} more`);
    const proto = Object.getPrototypeOf(v);
    const cls = proto && proto !== Object.prototype && proto.constructor && proto.constructor.name ? proto.constructor.name + ' ' : '';
    return `${cls}{${items.length ? ' ' + items.join(', ') + ' ' : ''}}`;
  } finally { seen.delete(v); }
}
