// Patches tab: every active Harmony-style patch, with call and error counts.
import { h, icon } from '../ui/dom.js';
import { B } from './brand.js';

const COVER = { all: 'All calls', most: 'Most calls', pending: 'Reload needed', indirect: 'Indirect calls' };
const COVER_TIP = {
  all: 'Direct calls to this method were rewritten when the game loaded, so every call is intercepted.',
  most: 'Every call is intercepted except direct calls from a few functions the rewriter couldn\'t read (see the note above).',
  pending: 'Intercepts indirect calls now. Reload the page and direct calls are covered too.',
  indirect: 'Only indirect calls (virtual, interface, delegates, Unity messages) are intercepted: see the note above for why.',
};

export class PatchesView {
  constructor(app) {
    this.app = app;
    this.loader = app.loader;
    this.body = h('div.bl-patches');
    this.count = h('span.ue-count');
    this.banner = h('div');
    this.el = h('div.bl-view',
      h('div.ue-bar', h('b', { style: { fontSize: '13px' } }, 'Active patches'), h('span', { style: { flex: 1 } }), this.count),
      this.banner,
      h('div.ue-scroll', this.body));
    this.loader.on('patches', () => this.render());
    this.render();
    setInterval(() => { if (this.el.offsetParent) this.render(); }, 1000);
  }

  render() {
    const L = this.loader;
    const list = L.patcher.list();
    this.count.textContent = `${list.length} patch${list.length === 1 ? '' : 'es'}`;
    this.body.replaceChildren();
    this.renderBanner(list);
    if (!list.length) { this.body.append(h('div.ue-empty', 'No patches. Banans add them with this.patch("Type::Method", { prefix, postfix }).')); return; }
    const head = h('div.bl-prow.head', h('span', 'Target'), h('span', 'Owner'), h('span', 'Hooks'), h('span', 'Covers'), h('span', 'Calls'), h('span', 'Errors'), h('span'));
    this.body.append(head);
    for (const p of list) {
      const owner = p.owner ? p.owner.info.name : 'BananaLoader';
      const color = p.owner ? p.owner.info.color : '#e11d2e';
      this.body.append(h('div.bl-prow' + (p.active ? '' : '.off'), { title: p.active ? '' : 'Disabled after 100 errors (see Console). Unpatch it or reload its Banan.' },
        h('span.ue-mono', { title: p.target }, p.target),
        h('span', { style: { color } }, owner),
        h('span', [p.prefix ? 'prefix' : null, p.postfix ? 'postfix' : null].filter(Boolean).join(' + ')),
        h('span', { class: 'bl-cov ' + p.coverage, title: COVER_TIP[p.coverage] }, COVER[p.coverage] || p.coverage),
        h('span.ue-mono', p.calls.toLocaleString()),
        h('span.ue-mono' + (p.errors ? '.v-err' : ''), String(p.errors)),
        p.owner ? h('button.ue-ib', { title: 'Unpatch', html: B.x, on: { click: () => { p.unpatch(); this.render(); } } }) : h('span')));
    }
    void icon;
  }

  renderBanner(list) {
    const L = this.loader;
    const w = L.patcher.wasm;
    const pend = L.patcher.pendingDirect();
    const S = L.settings;
    let note = null;
    if (!list.length) note = null;
    else if (S.directCalls === false) note = h('div.ue-note', { html: 'Direct-call patching is off (Settings). Patches only catch indirect calls: virtual and interface methods, delegates, Unity messages, events and reflection.' });
    else if (S.safeMode) note = h('div.ue-note', { html: 'Safe mode is on, so the game\'s wasm isn\'t rewritten: patches only catch indirect calls.' });
    else if (!w) note = h('div.ue-note.warn', { html: 'BananaLoader attached after the game\'s code loaded, so patches only catch indirect calls. Run it at <b>document-start</b> (the userscript default) to patch direct calls too.' });
    else if (w.error) note = h('div.ue-note.warn', h('b', 'Direct-call rewriting failed: '), h('span', w.error), h('span', ' Patches catch indirect calls only. Please report this with the game\'s link.'));
    else if (pend.length) {
      note = h('div.ue-note.warn', h('span', { html: `<b>${pend.length} patch${pend.length === 1 ? '' : 'es'}</b> will also catch direct calls after a reload: the game's wasm is rewritten as it loads so calls compiled straight into game code go through the patch. Turn on <b>Catch direct calls without reloading</b> in Settings to skip this step. ` }),
        h('button.ue-btn.pri', { style: { marginTop: '8px' }, on: { click: () => location.reload() } }, icon(B.refresh, 'i'), 'Reload now'));
    } else if (w.mode === 'all' && w.slotVia) note = h('div.ue-note', { html: `Every method's direct calls go through the function table (${w.sites.toLocaleString()} call sites rewritten in ${w.ms} ms), so new patches catch every call straight away.${w.skipped ? ` ${w.skipped} function${w.skipped === 1 ? '' : 's'} couldn't be read and kept their direct calls.` : ''}` });
    else if (w.applied && w.applied.length) note = h('div.ue-note', { html: `Direct-call patching active: ${w.applied.length} method${w.applied.length === 1 ? '' : 's'}, ${w.sites.toLocaleString()} call site${w.sites === 1 ? '' : 's'} rewritten in ${w.ms} ms.${w.skipped ? ` ${w.skipped} function${w.skipped === 1 ? '' : 's'} couldn't be read and kept their direct calls.` : ''}` });
    else note = h('div.ue-note', { html: 'Patches catch every call. New patches cover indirect calls straight away and direct calls after the next reload.' });
    if (note) this.banner.replaceChildren(note); else this.banner.replaceChildren();
  }
}
