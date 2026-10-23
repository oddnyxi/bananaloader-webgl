import { THEMES } from '../../constants.js';
import { Icons } from '../../icons.js';
import { copyText } from '../../utils/clipboard.js';

/** Adds a ready-made Settings tab: theme, accent, opacity, window icon, toggle key and config save/load. */
export function addSettingsTab(name = 'Settings', o = {}) {
  const t = this.addTab(name, { group: o.group, icon: o.icon ?? Icons.settings });

  t.createSection('Appearance');
  t.createDropdown(Object.keys(THEMES), (v) => this.setTheme(v), { label: 'Theme', selected: 0, save: false });
  this._accentCtl = t.createColorPicker('Accent Color', (v) => this.setAccent(v), { value: this.accent, save: false });
  this._opCtl = t.createSlider('Window Opacity', (v) => this.setOpacity(v / 100), {
    min: 30, max: 100, value: Math.round(this._opacity * 100), suffix: '%', save: false,
  });
  t.createTextInput('Window Icon URL', () => {}, {
    placeholder: 'png url, press Enter (empty = default)',
    value: this._icon || '',
    save: false,
    onEnter: (v) => {
      this.setWindowIcon(v.trim() || null);
      this.notify(v.trim() ? 'Window icon set' : 'Window icon reset', 'info');
    },
  });

  t.createSection('Controls');
  this._tkCtl = t.createKeybind('Toggle Key', (k) => { if (k) this.setToggleKey(k); }, { value: this.toggleKey, save: false });

  t.createSection('Config');
  const [a, b] = t.createColumns(2);
  a.createButton('Save', () => {
    const ok = this.saveConfig();
    this.notify(ok ? 'Config saved' : 'Save failed', ok ? 'success' : 'error');
  });
  b.createButton('Load', () => {
    const ok = this.loadConfig();
    this.notify(ok ? 'Config loaded' : 'Nothing to load', ok ? 'success' : 'warn');
  });

  const [c, d] = t.createColumns(2);
  c.createButton('Export', async () => this.notify((await copyText(this.exportConfig())) ? 'Copied to clipboard' : 'Copy failed', 'info'));
  d.createButton('Import', async () => {
    const v = await this.prompt('Paste config JSON', { title: 'Import Config', multiline: true });
    if (v) {
      const ok = this.importConfig(v);
      this.notify(ok ? 'Config imported' : 'Invalid config', ok ? 'success' : 'error');
    }
  });

  t.createButton('Reset To Defaults', async () => {
    if (await this.confirm('Reset every saved control to its default value?', { title: 'Reset', yes: 'Reset' })) {
      this.resetConfig();
      this.notify('Defaults restored', 'info');
    }
  });
  return t;
}
