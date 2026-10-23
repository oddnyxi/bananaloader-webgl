// addEventListener that bypasses page-level patches (Unity Explorer wraps the game's key
// listeners so keystrokes typed into the UI don't reach the game; the UI's own must not be).
const P = EventTarget.prototype;
export const listen = (t, type, fn, opts) => (P.__ueAdd || P.addEventListener).call(t, type, fn, opts);
export const unlisten = (t, type, fn, opts) => (P.__ueRemove || P.removeEventListener).call(t, type, fn, opts);
