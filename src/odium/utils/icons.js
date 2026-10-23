export const isUrl = (s) => {
  if (typeof s !== 'string') return false;
  s = s.trim();
  return (
    /^(https?:|data:|blob:|file:)/i.test(s) ||
    /^\.{0,2}\/\S/.test(s) ||
    /\.(png|jpe?g|gif|webp|svg|ico|avif|bmp)([?#].*)?$/i.test(s)
  );
};

/** An icon is either an image URL (png/svg/data:/blob:) or a plain glyph / emoji string. */
export const isSvg = (s) => typeof s === 'string' && s.trim().startsWith('<svg');

export const makeIcon = (icon, cls = '') => {
  let n;
  if (isSvg(icon)) {
    n = document.createElement('span');
    n.className = (cls + ' ico-svg').trim();
    n.innerHTML = icon.trim();
  } else if (isUrl(icon)) {
    n = document.createElement('img');
    n.src = icon.trim();
    n.alt = '';
    n.draggable = false;
    n.className = (cls + ' ico-img').trim();
    n.addEventListener('error', () => { n.style.display = 'none'; });
  } else {
    n = document.createElement('span');
    n.className = (cls + ' ico-g').trim();
    n.textContent = icon == null ? '' : icon;
  }
  return n;
};

/** Replace a node's contents with an icon (image or glyph). */
export const fillIcon = (node, icon) => {
  node.textContent = '';
  if (isSvg(icon)) node.innerHTML = icon.trim();
  else if (isUrl(icon)) node.appendChild(makeIcon(icon, 'icn-img'));
  else node.textContent = icon == null ? '' : icon;
};
