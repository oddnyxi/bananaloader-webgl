import { el } from './dom.js';

/**
 * Shared checkbox/radio list used by MultiSelect, RadioGroup and CheckboxGroup.
 * Returns { node, get, set, setOptions }.
 */
export const choiceList = (opts, multi, sel, cls, onPick) => {
  const root = el('div', cls);
  let options = opts.slice();
  let chosen = new Set(sel);

  const draw = () => {
    root.innerHTML = '';
    options.forEach((o) => {
      const r = el('div', 'opt' + (chosen.has(o) ? ' on' : ''));
      const m = el('span', multi ? 'chk' : 'rad');
      const t = el('span');
      t.textContent = o;
      r.append(m, t);
      r.onclick = (e) => {
        e.stopPropagation();
        if (multi) { chosen.has(o) ? chosen.delete(o) : chosen.add(o); }
        else chosen = new Set([o]);
        draw();
        onPick();
      };
      root.appendChild(r);
    });
  };
  draw();

  return {
    node: root,
    get: () => (multi ? options.filter((o) => chosen.has(o)) : [...chosen][0]),
    set: (v) => { const a = Array.isArray(v) ? v : v == null ? [] : [v]; chosen = new Set(multi ? a : a.slice(0, 1)); draw(); },
    setOptions: (a) => { options = a.slice(); chosen = new Set([...chosen].filter((x) => options.includes(x))); draw(); },
  };
};
