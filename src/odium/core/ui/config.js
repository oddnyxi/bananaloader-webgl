import { STORAGE_PREFIX } from '../../constants.js';
import { safe } from '../../utils/dom.js';

/** Current values of every registered control plus window appearance. */
export function snapshot() {
  const values = {};
  this.reg.forEach((c, k) => { values[k] = c.getValue(); });
  return { values, ui: { accent: this.accent, opacity: this._opacity, toggleKey: this.toggleKey, icon: this._icon } };
}

export function exportConfig() {
  return JSON.stringify(this.snapshot(), null, 2);
}

/** Accepts a JSON string or object. Returns false when it can't be parsed. */
export function importConfig(json) {
  try {
    const d = typeof json === 'string' ? JSON.parse(json) : json;
    if (d.ui) {
      if (d.ui.accent) this.setAccent(d.ui.accent);
      if (d.ui.opacity != null) this.setOpacity(d.ui.opacity);
      if (d.ui.toggleKey) this.setToggleKey(d.ui.toggleKey);
      if (d.ui.icon !== undefined) this.setWindowIcon(d.ui.icon);
    }
    Object.entries(d.values || {}).forEach(([k, v]) => {
      const c = this.reg.get(k);
      if (c) safe(() => c.setValue(v));
    });
    return true;
  } catch {
    return false;
  }
}

export function saveConfig(name = 'default') {
  try { localStorage.setItem(STORAGE_PREFIX + name, this.exportConfig()); return true; } catch { return false; }
}

export function loadConfig(name = 'default') {
  try {
    const s = localStorage.getItem(STORAGE_PREFIX + name);
    return s ? this.importConfig(s) : false;
  } catch {
    return false;
  }
}

export function resetConfig() {
  this.reg.forEach((c) => safe(() => c.setValue(c._def)));
}
