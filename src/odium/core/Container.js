import { Handle } from './Handle.js';

/**
 * Anything that can hold controls: a Tab, a Group, a Column, a SubTab pane.
 * The create*() methods are mixed in by ./install.js so each component can
 * live in its own file under src/components/.
 */
export class Container {
  constructor(ui, body, path, node = body) {
    this.ui = ui;
    this.page = body;
    this.path = path;
    this.el = node;
    this._sig = [];
    this._cm = null;
    this._hk = null;
    this._key = null;
  }

  /** Wrap a node in a Handle and append it to this container. */
  _ctl(node) {
    const c = new Handle(this.ui, node);
    this.page.appendChild(node);
    return c;
  }

  /**
   * Register a control for save/load/reset. Pass { save: false } to skip,
   * or { id } to give it a stable config key.
   */
  _reg(c, label, o = {}) {
    if (o.icon) c.setIcon(o.icon);
    if (o.save === false) return c;
    const base = o.id || `${this.path}/${label}`;
    let k = base, i = 2;
    while (this.ui.reg.has(k)) k = `${base}#${i++}`;
    c._key = k;
    c._def = c.getValue();
    this.ui.reg.set(k, c);
    return c;
  }
}

// Containers share the Handle API (setVisible, setEnabled, ctx, ...).
for (const k of Object.getOwnPropertyNames(Handle.prototype)) {
  if (k !== 'constructor') {
    Object.defineProperty(Container.prototype, k, Object.getOwnPropertyDescriptor(Handle.prototype, k));
  }
}

