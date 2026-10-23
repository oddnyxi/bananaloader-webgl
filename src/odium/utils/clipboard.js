export const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const a = document.createElement('textarea');
    a.value = text;
    a.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(a);
    a.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    a.remove();
    return ok;
  }
};
