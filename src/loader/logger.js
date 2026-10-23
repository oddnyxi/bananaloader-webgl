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
    const text = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? (a.stack || a.message) : safeJson(a))).join(' ');
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

function safeJson(v) {
  if (v === undefined) return 'undefined';
  if (typeof v === 'bigint') return v.toString() + 'n';
  if (v && typeof v === 'object' && typeof v.toString === 'function' && v.toString !== Object.prototype.toString) {
    try { return v.toString(); } catch (_) { /* fall through */ }
  }
  try { return JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() + 'n' : x)); } catch (_) { return String(v); }
}
