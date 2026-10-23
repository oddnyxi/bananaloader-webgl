/**
 * Closes a popup (dropdown list, multi-select) on the next click outside `node`,
 * whether that click lands elsewhere in the UI or on the page behind it.
 */
export function openPopup(ui, node, cls = 'open') {
  if (node.classList.contains(cls)) { node.classList.remove(cls); return; }
  node.classList.add(cls);
  const inside = (e) => { if (!node.contains(e.target)) close(); };
  const outside = (e) => { if (e.target !== ui.host) close(); };
  const close = () => {
    node.classList.remove(cls);
    ui.root && ui.root.removeEventListener('pointerdown', inside, true);
    window.removeEventListener('pointerdown', outside, true);
  };
  setTimeout(() => {
    if (!node.classList.contains(cls)) return;
    ui.root && ui.root.addEventListener('pointerdown', inside, true);
    window.addEventListener('pointerdown', outside, true);
  }, 0);
}
