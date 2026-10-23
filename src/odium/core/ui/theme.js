import { THEMES } from '../../constants.js';
import { hexToRgb, toHex, mix } from '../../utils/color.js';
import { isUrl, isSvg, makeIcon } from '../../utils/icons.js';
import { DEFAULT_LOGO } from '../../assets/logo.js';

export function setAccent(hex) {
  const rgb = hexToRgb(hex);
  this.accent = toHex(...rgb);
  if (this.root) {
    const s = this.root.style;
    s.setProperty('--rgb', rgb.join(','));
    s.setProperty('--red', this.accent);
    s.setProperty('--red-hi', toHex(...mix(rgb, [255, 255, 255], 0.28)));
    s.setProperty('--red-lo', toHex(...mix(rgb, [0, 0, 0], 0.5)));
    // readable text colour on top of the accent
    s.setProperty('--on', 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] > 160 ? '#000' : '#fff');
  }
  if (this._accentCtl) this._accentCtl.setValue(this.accent, true);
  return this;
}

export function setTheme(name) {
  if (THEMES[name]) this.setAccent(THEMES[name]);
  return this;
}

export function setOpacity(v) {
  this._opacity = Math.min(1, Math.max(0.3, v));
  if (this.win) this.win.style.opacity = this._opacity;
  if (this._opCtl) this._opCtl.setValue(Math.round(this._opacity * 100), true);
  return this;
}

/**
 * Window logo.
 *   null / undefined / ''  -> the default logo
 *   false                  -> no logo
 *   string                 -> image URL (png/svg/data:/blob:), inline <svg>, or a short glyph
 */
export function setWindowIcon(icon) {
  this._icon = icon === false ? false : icon || null;
  const lg = this.win && this.win.querySelector('.logo');
  if (!lg) return this;
  const shown = this._icon === false ? null : this._icon || DEFAULT_LOGO;
  lg.innerHTML = '';
  lg.classList.remove('has-img');
  lg.classList.toggle('none', !shown);
  if (!shown) return this;
  if (isSvg(shown) || isUrl(shown)) {
    const im = makeIcon(shown, 'logo-img');
    if (im.tagName === 'IMG') im.addEventListener('error', () => { if (this._icon === icon && icon) this.setWindowIcon(null); });
    lg.classList.add('has-img');
    lg.appendChild(im);
  } else {
    lg.textContent = shown;
  }
  return this;
}
