import { Emitter } from '../util/events.js';
import { FILTERS } from '../config/defaults.js';
import { renderStill } from '../render/LookRenderer.js';
import { PhotoLibrary } from '../library/PhotoLibrary.js';

const $ = (id) => document.getElementById(id);

/**
 * Post-capture review. The stored original is never modified: looks are
 * rendered on demand (screen-size preview here, full resolution on Save/Share).
 * Emits 'close', 'retake'.
 */
export class ReviewView extends Emitter {
  constructor(library, toast) {
    super();
    this.library = library; this.toast = toast;
    this.el = { root: $('review'), img: $('reviewImg'), meta: $('reviewMeta'), filters: $('reviewFilters'), retake: $('rvRetake'), fav: $('rvFavorite'), share: $('rvShare'), done: $('rvDone'), strength: $('rvStrength'), strengthV: $('rvStrengthV') };
    this.record = null; this.look = 'natural'; this.strength = 1; this.url = null; this.bitmap = null; this.renderToken = 0;
    this.el.retake.addEventListener('click', () => { this.hide(); this.emit('retake'); });
    this.el.done.addEventListener('click', () => { this.hide(); this.emit('close'); });
    this.el.fav.addEventListener('click', async () => { if (!this.record) return; this.record = await this.library.update(this.record.id, { favorite: !this.record.favorite }); this.renderFav(); });
    this.el.share.addEventListener('click', () => this.share());
    this.el.filters.addEventListener('click', (ev) => { const b = ev.target.closest('.filter-chip'); if (b) this.setLook(b.dataset.id); });
    this.el.strength.addEventListener('input', () => { this.strength = parseFloat(this.el.strength.value); this.el.strengthV.textContent = `${Math.round(this.strength * 100)}%`; this.scheduleRender(); });
  }

  async show(record, { recommendedFilter = 'natural', initialFilter = 'natural', strength = 1 } = {}) {
    this.record = record;
    this.bitmap?.close?.();
    this.bitmap = await createImageBitmap(record.blob);
    this.el.filters.innerHTML = '';
    for (const f of FILTERS) { const b = document.createElement('button'); b.className = 'filter-chip'; b.dataset.id = f.id; b.textContent = f.id === 'natural' ? 'Original' : f.name; if (f.id === recommendedFilter && f.id !== 'natural') b.classList.add('recommended'); this.el.filters.appendChild(b); }
    this.strength = strength; this.el.strength.value = strength; this.el.strengthV.textContent = `${Math.round(strength * 100)}%`;
    const m = record.meta || {};
    const bits = [`${record.width}×${record.height}`, m.scene, m.auto ? 'auto' : 'manual', m.scores ? `score ${m.scores.overall}` : null, m.lighting?.advice].filter(Boolean);
    this.el.meta.textContent = bits.join('  ·  ');
    this.renderFav();
    this.el.root.hidden = false;
    this.setLook(initialFilter);
  }

  hide() {
    this.el.root.hidden = true;
    if (this.url) { URL.revokeObjectURL(this.url); this.url = null; }
    this.bitmap?.close?.(); this.bitmap = null;
  }

  renderFav() { this.el.fav.textContent = this.record?.favorite ? '♥' : '♡'; this.el.fav.setAttribute('aria-pressed', String(!!this.record?.favorite)); }

  setLook(id) {
    this.look = id;
    for (const b of this.el.filters.querySelectorAll('.filter-chip')) b.classList.toggle('active', b.dataset.id === id);
    this.el.share.textContent = 'Save / Share';
    this.el.strength.parentElement.hidden = id === 'natural';
    this.scheduleRender();
  }

  scheduleRender() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.render(), 30);
  }

  async render() {
    if (!this.bitmap) return;
    const token = ++this.renderToken;
    this.el.img.classList.add('busy');
    const side = Math.min(2048, Math.round(Math.max(window.innerWidth, window.innerHeight) * Math.min(2, window.devicePixelRatio || 1)));
    const canvas = renderStill(this.bitmap, { lookId: this.look, strength: this.strength, maxSide: side });
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
    if (token !== this.renderToken || !blob) return;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(blob);
    this.el.img.src = this.url;
    this.el.img.classList.remove('busy');
  }

  async share() {
    if (!this.record) return;
    let blob = this.record.blob;
    const name = `SmartCamera-${new Date(this.record.createdAt).toISOString().replace(/[:.]/g, '-')}${this.look !== 'natural' ? `-${this.look}` : ''}.jpg`;
    if (this.look !== 'natural' && this.strength > 0) {
      this.toast.show('Applying look…');
      const canvas = renderStill(this.bitmap || await createImageBitmap(this.record.blob), { lookId: this.look, strength: this.strength });
      blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.95));
    }
    this.library.update(this.record.id, { meta: { ...(this.record.meta || {}), look: this.look, strength: this.strength } }).then((r) => { if (r) this.record = r; }).catch(() => {});
    const result = await PhotoLibrary.export(blob, name);
    if (result === 'downloaded') this.toast.show('Saved a copy to your downloads');
    else if (result === 'shared') this.toast.show('Shared');
  }
}
