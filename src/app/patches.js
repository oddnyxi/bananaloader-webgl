// Patches tab: every active Harmony-style patch, with call and error counts.
import { h, icon } from '../ui/dom.js';
import { B } from './brand.js';

export class PatchesView {
  constructor(app) {
    this.app = app;
    this.loader = app.loader;
    this.body = h('div.bl-patches');
    this.count = h('span.ue-count');
    this.el = h('div.bl-view',
      h('div.ue-bar', h('b', { style: { fontSize: '13px' } }, 'Active patches'), h('span', { style: { flex: 1 } }), this.count),
      h('div.ue-note', { html: 'Patches intercept calls that go through the function table: virtual and interface calls, delegates, Unity messages (<code>Update</code>, <code>OnTriggerEnter</code>…), events and reflection. Non-virtual calls compiled straight into game code bypass them, the same way inlined methods bypass Harmony.' }),
      h('div.ue-scroll', this.body));
    this.render();
    setInterval(() => { if (this.el.offsetParent) this.render(); }, 1000);
  }

  render() {
    const L = this.loader;
    const list = L.patcher.list();
    this.count.textContent = `${list.length} patch${list.length === 1 ? '' : 'es'}`;
    this.body.replaceChildren();
    if (!list.length) { this.body.append(h('div.ue-empty', 'No patches. Banans add them with this.patch("Type::Method", { prefix, postfix }).')); return; }
    const head = h('div.bl-prow.head', h('span', 'Target'), h('span', 'Owner'), h('span', 'Hooks'), h('span', 'Calls'), h('span', 'Errors'), h('span'));
    this.body.append(head);
    for (const p of list) {
      const owner = p.owner ? p.owner.info.name : 'BananaLoader';
      const color = p.owner ? p.owner.info.color : '#e11d2e';
      this.body.append(h('div.bl-prow' + (p.active ? '' : '.off'),
        h('span.ue-mono', { title: p.target }, p.target),
        h('span', { style: { color } }, owner),
        h('span', [p.prefix ? 'prefix' : null, p.postfix ? 'postfix' : null].filter(Boolean).join(' + ')),
        h('span.ue-mono', p.calls.toLocaleString()),
        h('span.ue-mono' + (p.errors ? '.v-err' : ''), String(p.errors)),
        p.owner ? h('button.ue-ib', { title: 'Unpatch', html: B.x, on: { click: () => { p.unpatch(); this.render(); } } }) : h('span')));
    }
    void icon;
  }
}
