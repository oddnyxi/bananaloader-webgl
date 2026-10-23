import { Tab } from '../Tab.js';

export function addTab(name, o = {}) {
  const tab = new Tab(this, name, o);
  this.tabs.push(tab);
  if (this.win) {
    this._mount(tab);
    if (!this.active) this.selectTab(tab);
  }
  return tab;
}

export function selectTab(tab) {
  this.tabs.forEach((t) => {
    t.btn.classList.toggle('on', t === tab);
    t.page.classList.toggle('on', t === tab);
  });
  this.active = tab;
}

/** Append a tab (and its group heading, when the group changes) to the sidebar. */
export function _mount(tab) {
  if (tab.group && tab.group !== this._lastGroup) {
    const g = document.createElement('div');
    g.className = 'sgroup';
    g.textContent = tab.group;
    this.side.appendChild(g);
  }
  this._lastGroup = tab.group;
  this.side.appendChild(tab.btn);
  this.content.appendChild(tab.page);
}
