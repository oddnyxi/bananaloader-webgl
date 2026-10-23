/**
 * Fluent builder for context menus. Item shape is plain data, so you can also
 * pass raw arrays to ui.contextMenu(). Types: button, toggle, checkbox, radio,
 * label, accordion, and '-' for a separator.
 */
export class MenuBuilder {
  constructor(ui, items = []) {
    this.ui = ui;
    this.items = items;
  }

  _add(it) {
    this.items.push(it);
    const k = () => ('checked' in it && !('value' in it) ? 'checked' : 'value');
    const h = {
      item: it,
      getValue: () => { const x = it[k()]; return typeof x === 'function' ? x() : x; },
      setValue: (v) => { it[k()] = v; return h; },
      setText: (t) => { it.text = t; return h; },
      setIcon: (i) => { it.icon = i; return h; },
      setEnabled: (v) => { it.disabled = !v; return h; },
      setVisible: (v) => { it.hidden = !v; return h; },
      remove: () => { const i = this.items.indexOf(it); if (i >= 0) this.items.splice(i, 1); },
    };
    return h;
  }

  addButton(text, action, o = {}) { return this._add({ type: 'button', text, action, ...o }); }
  addToggle(text, onChange, value = false, o = {}) { return this._add({ type: 'toggle', text, onChange, value, ...o }); }
  addCheckbox(text, onChange, value = false, o = {}) { return this._add({ type: 'checkbox', text, onChange, value, ...o }); }
  addRadioGroup(text, options = [], onChange, o = {}) {
    return this._add({ type: 'radio', text, options, onChange, value: o.selected ?? o.value ?? options[0], ...o });
  }
  addLabel(text) { return this._add({ type: 'label', text }); }
  addSeparator() { this.items.push('-'); return this; }

  addAccordion(title, o = {}) {
    const it = { type: 'accordion', text: title, items: [], ...o };
    this.items.push(it);
    const sub = new MenuBuilder(this.ui, it.items);
    sub.item = it;
    sub.open = () => { it.open = true; return sub; };
    sub.close = () => { it.open = false; return sub; };
    return sub;
  }

  clear() { this.items.length = 0; return this; }
  show(x, y) { this.ui.contextMenu(this, x, y); return this; }
}
