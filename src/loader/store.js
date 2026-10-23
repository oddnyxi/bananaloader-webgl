// Where Banans live: IndexedDB (installed from files, URLs or the editor), plus an optional
// linked folder on disk (File System Access API, Chromium) that works like MelonLoader's Mods folder.

const DB = 'bananaloader';
const VERSION = 1;

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('banans')) db.createObjectStore('banans', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

export class Store {
  constructor() { this.db = null; }

  async ready() {
    if (!this.db) this.db = await open();
    return this;
  }

  async all() {
    await this.ready();
    return req(this.db.transaction('banans').objectStore('banans').getAll());
  }

  async put(rec) {
    await this.ready();
    rec.updatedAt = Date.now();
    await req(this.db.transaction('banans', 'readwrite').objectStore('banans').put(rec));
    return rec;
  }

  async remove(id) {
    await this.ready();
    return req(this.db.transaction('banans', 'readwrite').objectStore('banans').delete(id));
  }

  async getMeta(key) {
    await this.ready();
    return req(this.db.transaction('meta').objectStore('meta').get(key));
  }

  async setMeta(key, value) {
    await this.ready();
    return req(this.db.transaction('meta', 'readwrite').objectStore('meta').put(value, key));
  }

  // ---- linked folder

  get folderSupported() { return typeof window.showDirectoryPicker === 'function'; }

  async pickFolder() {
    const dir = await window.showDirectoryPicker({ id: 'banans', mode: 'read' });
    await this.setMeta('folder', dir);
    return dir;
  }

  async folder() {
    try { return (await this.getMeta('folder')) || null; } catch (_) { return null; }
  }

  async unlinkFolder() { await this.setMeta('folder', null); }

  /** 'granted' | 'prompt' | 'denied' | 'none' */
  async folderPermission(request = false) {
    const dir = await this.folder();
    if (!dir) return 'none';
    const o = { mode: 'read' };
    let s = await dir.queryPermission(o);
    if (s !== 'granted' && request) s = await dir.requestPermission(o);
    return s;
  }

  /** Read every *.js file in the linked folder: [{ file, source }] */
  async readFolder() {
    const dir = await this.folder();
    if (!dir) return [];
    const out = [];
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== 'file' || !/\.js$/i.test(name)) continue;
      const f = await h.getFile();
      out.push({ file: name, source: await f.text() });
    }
    return out.sort((a, b) => a.file.localeCompare(b.file));
  }
}
