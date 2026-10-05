import { Emitter } from '../util/events.js';
import { FILTERS } from '../config/defaults.js';
import { renderStill } from '../render/LookRenderer.js';
import { PhotoLibrary } from '../library/PhotoLibrary.js';

const $ = (id) => document.getElementById(id);

/**
 * Photo viewer. Swipe left/right to browse every photo, swipe down to return to
 * the camera. The stored original is never modified: looks are rendered on
 * demand (screen-size here, full resolution on Save/Share) and remembered per photo.
 * Emits 'close', 'retake', 'grid'.
 */
export class ReviewView extends Emitter {
  constructor(library, toast) {
    super();
    this.library = library; this.toast = toast;
    this.el = { root: $('review'), stage: $('rvStage'), img: $('reviewImg'), meta: $('reviewMeta'), filters: $('reviewFilters'), retake: $('rvRetake'), fav: $('rvFavorite'), share: $('rvShare'), done: $('rvDone'), strength: $('rvStrength'), strengthV: $('rvStrengthV'), counter: $('rvCounter'), back: $('rvBack'), all: $('rvAll') };
    this.list = []; this.index = 0; this.record = null;
    this.look = 'natural'; this.strength = 1; this.recommended = 'natural';
    this.url = null; this.bitmap = null; this.renderToken = 0;
    for (const f of FILTERS) { const b = document.createElement('button'); b.className = 'filter-chip'; b.dataset.id = f.id; b.textContent = f.id === 'natural' ? 'Original' : f.name; this.el.filters.appendChild(b); }
    this.el.retake.addEventListener('click', () => { this.hide(); this.emit('retake'); });
    this.el.done.addEventListener('click', () => { this.hide(); this.emit('close'); });
    this.el.back.addEventListener('click', () => { this.hide(); this.emit('close'); });
    this.el.all.addEventListener('click', () => { this.hide(); this.emit('grid'); });
    this.el.fav.addEventListener('click', async () => { if (!this.record) return; this.record = await this.library.update(this.record.id, { favorite: !this.record.favorite }); this.list[this.index] = this.record; this.renderFav(); });
    this.el.share.addEventListener('click', () => this.share());
    this.el.filters.addEventListener('click', (ev) => { const b = ev.target.closest('.filter-chip'); if (b) { this.setLook(b.dataset.id); this.persistLook(); } });
    this.el.strength.addEventListener('input', () => { this.strength = parseFloat(this.el.strength.value); this.el.strengthV.textContent = `${Math.round(this.strength * 100)}%`; this.scheduleRender(); this.persistLook(); });
    this.bindSwipe();
    document.addEventListener('keydown', (e) => {
      if (this.el.root.hidden) return;
      if (e.key === 'ArrowLeft') this.go(-1); else if (e.key === 'ArrowRight') this.go(1); else if (e.key === 'Escape') { this.hide(); this.emit('close'); }
    });
  }

  get isOpen() { return !this.el.root.hidden; }

  /** Open on a record (or the newest photo when none is given). */
  async show(record = null, { recommendedFilter = null, initialFilter = null, strength = null } = {}) {
    this.list = await this.library.all();
    if (!this.list.length) { this.toast.show('No photos yet'); return false; }
    this.index = Math.max(0, record ? this.list.findIndex((r) => r.id === record.id) : 0);
    this.el.root.hidden = false;
    await this.load(this.index, { recommendedFilter, initialFilter, strength });
    try {
      if (this.list.length > 1 && !localStorage.getItem('smart-camera.swipe-hint')) {
        this.toast.show('Swipe to browse · swipe down for the camera', 3000);
        localStorage.setItem('smart-camera.swipe-hint', '1');
      }
    } catch { /* private mode */ }
    return true;
  }

  async load(i, { recommendedFilter = null, initialFilter = null, strength = null } = {}) {
    this.index = i;
    this.record = this.list[i];
    const m = this.record.meta || {};
    this.recommended = recommendedFilter || m.filter || 'natural';
    for (const b of this.el.filters.querySelectorAll('.filter-chip')) b.classList.toggle('recommended', b.dataset.id === this.recommended && b.dataset.id !== 'natural');
    this.strength = strength ?? m.strength ?? 1;
    this.el.strength.value = this.strength; this.el.strengthV.textContent = `${Math.round(this.strength * 100)}%`;
    const bits = [`${this.record.width}×${this.record.height}`, m.scene, m.auto ? 'auto' : null, m.selfie ? 'selfie' : null].filter(Boolean);
    this.el.meta.textContent = bits.join('  ·  ');
    this.el.counter.textContent = `${i + 1} / ${this.list.length}`;
    this.renderFav();
    this.bitmap?.close?.();
    this.bitmap = await createImageBitmap(this.record.blob);
    this.setLook(initialFilter || m.look || 'natural');
  }

  hide() {
    this.el.root.hidden = true;
    if (this.url) { URL.revokeObjectURL(this.url); this.url = null; }
    this.bitmap?.close?.(); this.bitmap = null;
    this.el.img.removeAttribute('src');
  }

  renderFav() { this.el.fav.textContent = this.record?.favorite ? '♥' : '♡'; this.el.fav.setAttribute('aria-pressed', String(!!this.record?.favorite)); }

  setLook(id) {
    this.look = id;
    for (const b of this.el.filters.querySelectorAll('.filter-chip')) b.classList.toggle('active', b.dataset.id === id);
    this.el.strength.parentElement.hidden = id === 'natural';
    this.scheduleRender(0);
  }

  persistLook() {
    clearTimeout(this._p);
    const rec = this.record, look = this.look, strength = this.strength;
    this._p = setTimeout(async () => {
      const updated = await this.library.update(rec.id, { meta: { ...(rec.meta || {}), look, strength } }).catch(() => null);
      if (updated) { const i = this.list.findIndex((r) => r.id === rec.id); if (i >= 0) this.list[i] = updated; if (this.record?.id === rec.id) this.record = updated; }
    }, 300);
  }

  scheduleRender(delay = 30) { clearTimeout(this._t); this._t = setTimeout(() => this.render(), delay); }

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

  /** Move to the next (+1, older) or previous (−1, newer) photo with a slide. */
  async go(delta) {
    const next = this.index + delta;
    const img = this.el.img;
    if (next < 0 || next >= this.list.length) { this.bounce(); return; }
    const w = this.el.stage.clientWidth;
    img.classList.add('snap'); img.style.transform = `translateX(${-delta * w}px)`; img.style.opacity = '0';
    await new Promise((r) => setTimeout(r, 200));
    img.classList.remove('snap'); img.style.transform = `translateX(${delta * w * 0.4}px)`;
    await this.load(next);
    await new Promise((r) => requestAnimationFrame(r));
    img.classList.add('snap'); img.style.transform = ''; img.style.opacity = '';
  }

  bounce() { const img = this.el.img; img.classList.add('snap'); img.style.transform = ''; img.style.opacity = ''; }

  bindSwipe() {
    const stage = this.el.stage, img = this.el.img;
    let start = null;
    stage.addEventListener('pointerdown', (e) => { if (start) return; start = { x: e.clientX, y: e.clientY, id: e.pointerId, t: performance.now() }; img.classList.remove('snap'); stage.setPointerCapture?.(e.pointerId); });
    stage.addEventListener('pointermove', (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (Math.abs(dy) > Math.abs(dx) && dy > 0) { img.style.transform = `translateY(${dy}px) scale(${Math.max(0.8, 1 - dy / 1500)})`; img.style.opacity = String(Math.max(0.4, 1 - dy / 600)); }
      else { const edge = (dx > 0 && this.index === 0) || (dx < 0 && this.index === this.list.length - 1); img.style.transform = `translateX(${edge ? dx * 0.3 : dx}px)`; }
    });
    const end = (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y, dt = performance.now() - start.t;
      start = null;
      const fast = dt < 250;
      if (dy > 110 && Math.abs(dy) > Math.abs(dx)) { img.classList.add('snap'); img.style.transform = `translateY(${window.innerHeight}px)`; img.style.opacity = '0'; setTimeout(() => { img.style.transform = ''; img.style.opacity = ''; this.hide(); this.emit('close'); }, 200); return; }
      if (dx < -60 || (fast && dx < -25)) this.go(1);
      else if (dx > 60 || (fast && dx > 25)) this.go(-1);
      else this.bounce();
    };
    stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
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
    const result = await PhotoLibrary.export(blob, name);
    if (result === 'downloaded') this.toast.show('Saved a copy to your downloads');
    else if (result === 'shared') this.toast.show('Shared');
  }
}
