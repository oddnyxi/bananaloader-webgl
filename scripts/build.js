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
const code = await out.outputs[0].text();

if (cfg.icon && !/^(https?:|data:)/i.test(cfg.icon) && existsSync(resolve(root, cfg.icon))) {
  cfg.icon = `data:image/png;base64,${readFileSync(resolve(root, cfg.icon)).toString('base64')}`;
}
const { name, namespace, ...rest } = cfg;
const entries = Object.entries({ name, namespace, version: pkg.version, ...rest }).filter(([, v]) => v != null && v !== false);
const pad = Math.max(...entries.map(([k]) => k.length)) + 1;
const lines = [];
for (const [k, v] of entries) for (const x of [].concat(v)) lines.push(v === true ? `// @${k}` : `// @${k.padEnd(pad)} ${x}`);
const header = ['// ==UserScript==', ...lines, '// ==/UserScript=='].join('\n') + '\n\n';

writeFileSync(resolve(root, 'dist/bananaloader.user.js'), header + code);
writeFileSync(resolve(root, 'dist/bananaloader.js'), code);
console.log(`Built dist/bananaloader.user.js (${(code.length / 1024).toFixed(0)} KB${minify ? ', minified' : ''})`);
