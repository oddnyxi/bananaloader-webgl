// Preferences tab: every BananaPreferences category as Odium UI controls.
import { h, icon } from '../ui/dom.js';
import { B } from './brand.js';

export class PrefsView {
  constructor(app, tab) {
    this.app = app;
    this.tab = tab;
    this.loader = app.loader;
    this.unsub = [];
    this.groups = new Map();
    this.loader.prefs.on('layout', () => this.schedule());
    this.loader.on('banans', () => this.schedule());
    this.render();
  }

  schedule() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.render(), 60);
  }

  render() {
    const t = this.tab;
    for (const u of this.unsub) u();
    this.unsub = [];
    t.page.replaceChildren();
    this.groups.clear();
    const cats = [...this.loader.prefs.categories.values()].filter((c) => [...c.entries.values()].some((e) => !e.hidden));
    t.createSection('Preferences');
    if (!cats.length) {
      t.page.append(h('div.ue-note', { html: 'No preferences yet. Banans create them with <code>this.pref(id, default, name, options)</code> and they show up here, saved automatically.' }));
      return;
    }
    for (const c of cats) {
      const g = t.createGroup(c.name, { icon: B.sliders });
      this.groups.set(c.id, g);
      for (const e of c.entries.values()) {
        if (e.hidden) continue;
        const ctl = this.control(g, e);
        if (!ctl) continue;
        if (e.description) ctl.setTooltip(e.description);
        this.unsub.push(e.onChange((v) => { try { ctl.setValue(v, true); } catch (_) { /* ignore */ } }));
      }
      const row = h('div', { style: { display: 'flex', gap: '8px', marginTop: '4px' } },
        h('button.ue-btn', { on: { click: () => { for (const e of c.entries.values()) e.reset(); this.app.notify(`${c.name}: defaults restored`, 'info'); } } }, icon(B.refresh, 'i'), 'Reset to defaults'));
      g.page.append(row);
    }
    const foot = h('div', { style: { display: 'flex', gap: '8px' } },
      h('button.ue-btn', { on: { click: () => { this.loader.prefs.save(); this.app.notify('Preferences saved', 'success'); } } }, icon(B.save, 'i'), 'Save now'),
      h('button.ue-btn', { on: { click: () => { this.loader.prefs.load(); this.app.notify('Preferences reloaded', 'info'); } } }, icon(B.sync, 'i'), 'Reload from storage'));
    t.page.append(foot);
  }

  control(g, e) {
    const o = { save: false };
    const set = (v) => e.set(v);
    switch (e.kind) {
      case 'bool': return g.createToggle(e.name, set, e.value, o);
      case 'key': return g.createKeybind(e.name, (k) => { if (k !== undefined) set(k); }, { ...o, value: e.value });
      case 'color': return g.createColorPicker(e.name, set, { ...o, value: e.value });
      case 'json': {
        const text = (v) => { try { return JSON.stringify(v); } catch (_) { return ''; } };
        return g.createTextInput(e.name, (v) => { try { set(JSON.parse(v)); } catch (_) { this.app.notify(`${e.name}: not valid JSON`, 'error'); } }, { ...o, value: text(e.value), placeholder: text(e.default) });
      }
      case 'number':
        if (e.min != null && e.max != null) return g.createSlider(e.name, set, { ...o, min: e.min, max: e.max, step: e.step ?? ((e.max - e.min) / 100 || 1), value: e.value });
        return g.createNumberInput(e.name, set, { ...o, min: e.min, max: e.max, step: e.step ?? 1, value: e.value });
      default:
        if (e.options) return g.createDropdown(e.options, set, { ...o, label: e.name, selected: Math.max(0, e.options.indexOf(e.value)) });
        return g.createTextInput(e.name, set, { ...o, value: e.value, placeholder: String(e.default ?? '') });
    }
  }

  focus(id) {
    const g = this.groups.get(id);
    if (g && g.el) g.el.scrollIntoView({ block: 'start' });
  }
}
