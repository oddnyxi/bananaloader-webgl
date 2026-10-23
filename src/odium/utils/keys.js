import { MODIFIER_KEYS } from '../constants.js';

/** Turn a KeyboardEvent into a spec like "Ctrl+Shift+K". Returns null for bare modifier presses. */
export const keySpec = (e) => {
  if (MODIFIER_KEYS.includes(e.key)) return null;
  const p = [];
  if (e.ctrlKey) p.push('Ctrl');
  if (e.altKey) p.push('Alt');
  if (e.shiftKey) p.push('Shift');
  if (e.metaKey) p.push('Meta');
  p.push(e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key);
  return p.join('+');
};
