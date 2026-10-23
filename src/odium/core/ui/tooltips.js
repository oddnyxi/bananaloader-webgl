/** Shows the element's data-tip text after a short hover delay. */
export function enableTooltips(ui) {
  let timer;
  ui.root.addEventListener('mouseover', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    clearTimeout(timer);
    if (!t) { ui.tip.style.display = 'none'; return; }
    timer = setTimeout(() => {
      ui.tip.textContent = t.dataset.tip;
      ui.tip.style.display = 'block';
      const r = t.getBoundingClientRect();
      const tw = ui.tip.offsetWidth, th = ui.tip.offsetHeight;
      ui.tip.style.left = Math.min(Math.max(6, r.left + r.width / 2 - tw / 2), innerWidth - tw - 6) + 'px';
      ui.tip.style.top = (r.top - th - 8 < 6 ? r.bottom + 8 : r.top - th - 8) + 'px';
    }, 350);
  });
  ui.root.addEventListener('mouseleave', () => { clearTimeout(timer); ui.tip.style.display = 'none'; });
  ui.root.addEventListener('pointerdown', () => { clearTimeout(timer); ui.tip.style.display = 'none'; });
}
