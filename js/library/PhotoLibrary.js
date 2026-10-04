import { Emitter } from '../util/events.js';

const DB = 'smart-camera'; const STORE = 'photos'; const VER = 1;

/**
 * Local photo library (IndexedDB). The web cannot write into the system Photos
 * app directly, so captures are kept here at full quality; "Save / Share" hands
 * the original file to the system share sheet (iOS: Save Image → Photos) or
 * triggers a download. Only photos taken by this app live here; the user's own
 * library is never touched or deleted.
 *
 * Record: { id, createdAt, blob, thumb, width, height, favorite, meta }
 */
export class PhotoLibrary extends Emitter {
  constructor() { super(); this.db = null; }

  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, VER);
      req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) { const s = db.createObjectStore(STORE, { keyPath: 'id' }); s.createIndex('createdAt', 'createdAt'); } };
      req.onsuccess = () => { this.db = req.result; resolve(this.db); };
      req.onerror = () => reject(req.error);
    });
  }

  tx(mode) { return this.db.transaction(STORE, mode).objectStore(STORE); }
  wrap(req) { return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); }); }

  async add(record) {
    await this.open();
    const rec = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, createdAt: Date.now(), favorite: false, ...record };
    await this.wrap(this.tx('readwrite').put(rec));
    this.emit('change', { type: 'add', id: rec.id });
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    return rec;
  }

  async get(id) { await this.open(); return this.wrap(this.tx('readonly').get(id)); }
  async all() { await this.open(); const rows = await this.wrap(this.tx('readonly').getAll()); return rows.sort((a, b) => b.createdAt - a.createdAt); }
  async count() { await this.open(); return this.wrap(this.tx('readonly').count()); }
  async latest() { const rows = await this.all(); return rows[0] || null; }

  async update(id, patch) {
    await this.open();
    const rec = await this.get(id); if (!rec) return null;
    const next = { ...rec, ...patch };
    await this.wrap(this.tx('readwrite').put(next));
    this.emit('change', { type: 'update', id });
    return next;
  }

  /** Removes one of this app's own captures (never anything outside this store). */
  async remove(id) { await this.open(); await this.wrap(this.tx('readwrite').delete(id)); this.emit('change', { type: 'remove', id }); }

  /** Share or download a file. Returns 'shared' | 'downloaded' | 'cancelled'. */
  static async export(blob, filename) {
    const file = new File([blob], filename, { type: blob.type || 'image/jpeg' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Smart Camera' }); return 'shared'; }
      catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return 'downloaded';
  }
}
