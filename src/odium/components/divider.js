import { el } from '../utils/dom.js';

export function createDivider() {
  return this._ctl(el('div', 'divider'));
}
