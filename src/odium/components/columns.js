import { Container } from '../core/Container.js';
import { el } from '../utils/dom.js';

/** Returns an array of n Containers laid out side by side. */
export function createColumns(n = 2) {
  const row = el('div', 'cols');
  row.style.gridTemplateColumns = `repeat(${n}, minmax(0, 1fr))`;
  this.page.appendChild(row);

  const cols = [];
  for (let i = 0; i < n; i++) {
    const col = el('div', 'col');
    row.appendChild(col);
    cols.push(new Container(this.ui, col, `${this.path}/col${i + 1}`));
  }
  cols.el = row;
  return cols;
}
