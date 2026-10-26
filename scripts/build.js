// bun scripts/build.js [--readable]
// Bundles src/main.js into dist/bananaloader.user.js (userscript) and dist/bananaloader.js (plain).
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const minify = !process.argv.includes('--readable');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const cfg = JSON.parse(readFileSync(resolve(root, 'userscript.config.json'), 'utf8'));

// Parcel-style "bundle-text:" imports: inline a CSS file (following @import) as a string.
const inlineCss = (file) =>
  readFileSync(file, 'utf8').replace(/@import\s+["'](.+?)["'];?/g, (_, p) => inlineCss(resolve(dirname(file), p)));
const bundleText = {
  name: 'bundle-text',
  setup(build) {
    build.onResolve({ filter: /^bundle-text:/ }, (a) => ({ path: resolve(dirname(a.importer), a.path.slice(12)), namespace: 'bundle-text' }));
    build.onLoad({ filter: /.*/, namespace: 'bundle-text' }, (a) => ({ contents: `export default ${JSON.stringify(inlineCss(a.path))};`, loader: 'js' }));
  },
};

rmSync(resolve(root, 'dist'), { recursive: true, force: true });
mkdirSync(resolve(root, 'dist'), { recursive: true });
const out = await Bun.build({ entrypoints: [resolve(root, 'src/main.js')], target: 'browser', format: 'iife', minify, plugins: [bundleText] });
if (!out.success) { out.logs.forEach((l) => console.error(l)); process.exit(1); }
let code = await out.outputs[0].text();

if (cfg.icon && !/^(https?:|data:)/i.test(cfg.icon) && existsSync(resolve(root, cfg.icon))) {
  cfg.icon = `data:image/png;base64,${readFileSync(resolve(root, cfg.icon)).toString('base64')}`;
}
const { name, namespace, ...rest } = cfg;
const entries = Object.entries({ name, namespace, version: pkg.version, ...rest }).filter(([, v]) => v != null && v !== false);
const pad = Math.max(...entries.map(([k]) => k.length)) + 1;
const lines = [];
for (const [k, v] of entries) for (const x of [].concat(v)) lines.push(v === true ? `// @${k}` : `// @${k.padEnd(pad)} ${x}`);
const header = ['// ==UserScript==', ...lines, '// ==/UserScript=='].join('\n') + '\n\n';


// ASCII-only output: userscript managers inject the code as a <script> text node, and some of them
// mangle non-ASCII (U+FFFF in a regex once broke the whole script). \uXXXX escapes mean the same
// thing in strings, templates, regexes and comments.
const ascii = (s) => s.replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
code = ascii(code);
// bananaloader.com serves logged-in users a copy with their read-only loader key on this exact line
// (it replaces it textually), so keep it on a line of its own, outside the minified bundle. The wrapper
// keeps it out of the page's global scope when a manager injects the script as a <script> tag.
code = `(() => {\nconst BAKED_REGISTRY_KEY = '';\n${code}\n})();\n`;
writeFileSync(resolve(root, 'dist/bananaloader.user.js'), header + code);
writeFileSync(resolve(root, 'dist/bananaloader.js'), code);
console.log(`Built dist/bananaloader.user.js (${(code.length / 1024).toFixed(0)} KB${minify ? ', minified' : ''})`);
