import { UI } from './core/UI.js';
import { Icons } from './icons.js';

// Handy for userscripts / the browser console. With "@grant none" this lands on the page's own window.
window.UI = UI;
window.OdiumUI = UI;
window.OdiumIcons = Icons;

export { UI, UI as OdiumUI, Icons };
export default UI;
