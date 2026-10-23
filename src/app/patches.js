// Patches tab: every active Harmony-style patch, with call and error counts.
import { h, icon } from '../ui/dom.js';
import { B } from './brand.js';

const COVER = { all: 'All calls', pending: 'Reload needed', indirect: 'Indirect calls' };
const COVER_TIP = {
  all: 'Direct calls to this method were rewritten when the game loaded, so every call is intercepted.',
  pending: 'Intercepts indirect calls now. Reload the page and direct calls are covered too.',
  indirect: 'BananaLoader attached after the game loaded, so only indirect calls (virtual, interface, delegates, Unity messages) are intercepted.',
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
    if (!list.length) { this.body.append(h('div.ue-empty', 'No patches. Banans add them with this.patch("Type::Method", { prefix, postfix }).')); return; }
    this.renderBanner();
    const head = h('div.bl-prow.head', h('span', 'Target'), h('span', 'Owner'), h('span', 'Hooks'), h('span', 'Covers'), h('span', 'Calls'), h('span', 'Errors'), h('span'));
    this.body.append(head);
    for (const p of list) {
      const owner = p.owner ? p.owner.info.name : 'BananaLoader';
      const color = p.owner ? p.owner.info.color : '#e11d2e';
      this.body.append(h('div.bl-prow' + (p.active ? '' : '.off'),
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

  renderBanner() {
    const L = this.loader;
    const w = L.patcher.wasm;
    const pend = L.patcher.pendingDirect();
    let note;
    if (L.settings.directCalls === false) note = h('div.ue-note', { html: 'Direct-call patching is off (Settings). Patches only catch indirect calls: virtual and interface methods, delegates, Unity messages, events and reflection.' });
    else if (!w) note = h('div.ue-note.warn', { html: 'BananaLoader attached after the game\'s code loaded, so patches only catch indirect calls. Run it at <b>document-start</b> (the userscript default) to patch direct calls too.' });
    else if (pend.length) {
      note = h('div.ue-note.warn', h('span', { html: `<b>${pend.length} patch${pend.length === 1 ? '' : 'es'}</b> will also catch direct calls after a reload: the game's wasm is rewritten as it loads so calls compiled straight into game code go through the patch. ` }),
        h('button.ue-btn.pri', { style: { marginTop: '8px' }, on: { click: () => location.reload() } }, icon(B.refresh, 'i'), 'Reload now'));
    } else if (w.applied && w.applied.length) note = h('div.ue-note', { html: `Direct-call patching active: ${w.applied.length} method${w.applied.length === 1 ? '' : 's'}, ${w.sites.toLocaleString()} call site${w.sites === 1 ? '' : 's'} rewritten in ${w.ms} ms${w.error ? ` (error: ${w.error})` : ''}.` });
    else note = h('div.ue-note', { html: 'Patches catch every call. New patches cover indirect calls straight away and direct calls after the next reload.' });
    this.banner.replaceChildren(note);
  }
}
