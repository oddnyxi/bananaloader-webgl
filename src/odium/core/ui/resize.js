/** Resize the window by dragging the bottom-right grip. */
export function enableResize(win, grip) {
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    grip.setPointerCapture(e.pointerId);
    const r = win.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;

    const move = (ev) => {
      win.style.width = Math.min(Math.max(400, r.width + ev.clientX - sx), innerWidth - r.left) + 'px';
      win.style.height = Math.min(Math.max(280, r.height + ev.clientY - sy), innerHeight - r.top) + 'px';
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
}
