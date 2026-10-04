import { Emitter } from '../util/events.js';
import { FILTERS } from '../config/defaults.js';
import { cssFilter, applyFilter } from '../capture/Filters.js';
import { PhotoLibrary } from '../library/PhotoLibrary.js';

const $ = (id) => document.getElementById(id);

/**
 * Post-capture review: preview, non-destructive filter preview, favourite,
 * save/share (original or filtered copy), retake. Emits 'close', 'retake'.
 */
export class ReviewView extends Emitter {
  constructor(library, toast) {
    super();
    this.library = library; this.toast = toast;
    this.el = { root: $('review'), img: $('reviewImg'), meta: $('reviewMeta'), filters: $('reviewFilters'), retake: $('rvRetake'), fav: $('rvFavorite'), share: $('rvShare'), done: $('rvDone') };
    this.record = null; this.filter = 'natural'; this.url = null;
    this.el.retake.addEventListener('click', () => { this.hide(); this.emit('retake'); });
    this.el.done.addEventListener('click', () => { this.hide(); this.emit('close'); });
    this.el.fav.addEventListener('click', async () => { if (!this.record) return; this.record = await this.library.update(this.record.id, { favorite: !this.record.favorite }); this.renderFav(); });
    this.el.share.addEventListener('click', () => this.share());
    this.el.filters.addEventListener('click', (ev) => { const b = ev.target.closest('.filter-chip'); if (!b) return; this.setFilter(b.dataset.id); });
  }

  show(record, { recommendedFilter = 'natural', initialFilter = 'natural' } = {}) {
    this.record = record; this.recommended = recommendedFilter;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(record.blob); this.el.img.src = this.url;
    this.el.filters.innerHTML = '';
    for (const f of FILTERS) { const b = document.createElement('button'); b.className = 'filter-chip'; b.dataset.id = f.id; b.textContent = f.name; if (f.id === recommendedFilter) b.classList.add('recommended'); this.el.filters.appendChild(b); }
    this.setFilter(initialFilter);
    const m = record.meta || {};
    const bits = [`${record.width}×${record.height}`, m.scene, m.auto ? 'auto' : 'manual', m.scores ? `score ${m.scores.overall}` : null, m.lighting?.advice].filter(Boolean);
    this.el.meta.textContent = bits.join('  ·  ');
    this.renderFav();
    this.el.root.hidden = false;
  }

  hide() { this.el.root.hidden = true; if (this.url) { URL.revokeObjectURL(this.url); this.url = null; } }
  renderFav() { this.el.fav.textContent = this.record?.favorite ? '♥' : '♡'; this.el.fav.setAttribute('aria-pressed', String(!!this.record?.favorite)); }
  setFilter(id) { this.filter = id; this.el.img.style.filter = cssFilter(id); for (const b of this.el.filters.querySelectorAll('.filter-chip')) b.classList.toggle('active', b.dataset.id === id); this.el.share.textContent = id === 'natural' ? 'Save / Share' : `Save / Share (${FILTERS.find((f) => f.id === id)?.name})`; }

  async share() {
    if (!this.record) return;
    let blob = this.record.blob;
    const name = `SmartCamera-${new Date(this.record.createdAt).toISOString().replace(/[:.]/g, '-')}${this.filter !== 'natural' ? `-${this.filter}` : ''}.jpg`;
    if (this.filter !== 'natural') {
      this.toast.show('Applying look…');
      const bmp = await createImageBitmap(this.record.blob);
      const c = await applyFilter(bmp, this.filter); bmp.close?.();
      blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
    }
    const result = await PhotoLibrary.export(blob, name);
    if (result === 'downloaded') this.toast.show('Saved a copy to your downloads');
    else if (result === 'shared') this.toast.show('Shared');
  }
}
