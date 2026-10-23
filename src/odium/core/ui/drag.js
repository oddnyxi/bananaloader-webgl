/** Drag the window by its header, with optional snapping to screen edges/centre. */
export function enableDrag(ui, win, head) {
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.wbtn')) return;
    const r = win.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);

    const move = (ev) => {
      const w = win.offsetWidth, h = win.offsetHeight;
      let x = Math.min(Math.max(0, ev.clientX - dx), Math.max(0, innerWidth - w));
      let y = Math.min(Math.max(0, ev.clientY - dy), Math.max(0, innerHeight - h));
      if (ui._snap) {
        const M = 12, T = 18; // margin, snap threshold
        [M, innerWidth - w - M, (innerWidth - w) / 2].forEach((s) => { if (Math.abs(x - s) < T) x = s; });
        [M, innerHeight - h - M, (innerHeight - h) / 2].forEach((s) => { if (Math.abs(y - s) < T) y = s; });
      }
      win.style.left = x + 'px';
      win.style.top = y + 'px';
    };
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
  });
}
