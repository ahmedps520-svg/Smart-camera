import { Emitter } from '../util/events.js';

const $ = (id) => document.getElementById(id);

/** Grid of the app's own captures. Emits 'open' {record}, 'close'. */
export class LibraryView extends Emitter {
  constructor(library) {
    super(); this.library = library;
    this.el = { root: $('library'), grid: $('libraryGrid'), count: $('libCount'), close: $('libClose') };
    this.urls = [];
    this.el.close.addEventListener('click', () => { this.hide(); this.emit('close'); });
    this.el.grid.addEventListener('click', async (ev) => { const it = ev.target.closest('.library-item'); if (!it) return; const rec = await this.library.get(it.dataset.id); if (rec) this.emit('open', rec); });
  }
  async show() {
    const rows = await this.library.all();
    this.revoke(); this.el.grid.innerHTML = '';
    this.el.count.textContent = rows.length ? `${rows.length}` : '';
    if (!rows.length) { const d = document.createElement('div'); d.className = 'library-empty'; d.textContent = 'No photos yet. Captures from Smart Camera appear here.'; this.el.grid.appendChild(d); }
    for (const r of rows) {
      const url = URL.createObjectURL(r.thumb || r.blob); this.urls.push(url);
      const d = document.createElement('div'); d.className = 'library-item'; d.dataset.id = r.id;
      d.innerHTML = `<img alt="" loading="lazy" src="${url}">${r.favorite ? '<span class="fav">♥</span>' : ''}${r.meta?.auto ? '<span class="badge">AUTO</span>' : ''}`;
      this.el.grid.appendChild(d);
    }
    this.el.root.hidden = false;
  }
  hide() { this.el.root.hidden = true; this.revoke(); }
  revoke() { this.urls.forEach((u) => URL.revokeObjectURL(u)); this.urls = []; }
}
