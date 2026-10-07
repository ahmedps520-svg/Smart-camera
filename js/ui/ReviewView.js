import { Emitter } from '../util/events.js';
import { FILTERS } from '../config/defaults.js';
import { renderStill, ADJUST_DEFAULTS } from '../render/LookRenderer.js';
import { autoEnhance } from '../render/AutoEnhance.js';
import { FRAMES, applyFrame, specsLine } from '../render/Frames.js';
import { PhotoLibrary } from '../library/PhotoLibrary.js';

const $ = (id) => document.getElementById(id);
const SLIDERS = [['light', 'Light'], ['contrast', 'Contrast'], ['warmth', 'Warmth'], ['saturation', 'Colour'], ['vignette', 'Vignette'], ['depth', 'Depth']];

/**
 * Editor / viewer shown after a shot (reference design): the photo with the
 * chosen frame, a strip of film looks rendered from the photo itself, frame
 * styles, delete, adjust and Save. Swipe left/right to browse, down to close.
 * The stored original is never modified; everything is rendered on demand.
 * Emits 'close', 'grid', 'deleted'.
 */
export class ReviewView extends Emitter {
  constructor(library, toast, settings) {
    super();
    this.library = library; this.toast = toast; this.settings = settings;
    this.el = { root: $('review'), stage: $('rvStage'), img: $('reviewImg'), meta: $('reviewMeta'), looks: $('reviewFilters'), frames: $('frameRow'), share: $('rvShare'), strength: $('rvStrength'), strengthV: $('rvStrengthV'), counter: $('rvCounter'), back: $('rvBack'), all: $('rvAll'), fav: $('rvFavorite'), del: $('rvDelete'), adjust: $('rvAdjust'), pane: $('paneEdit') };
    this.list = []; this.index = 0; this.record = null;
    this.look = 'natural'; this.strength = 1; this.frame = 'none'; this.recommended = 'natural';
    this.url = null; this.bitmap = null; this.maskBitmap = null; this.renderToken = 0;
    this.adjust = { ...ADJUST_DEFAULTS }; this.depth = 0;
    this.buildFrames(); this.buildEditor();
    this.el.back.addEventListener('click', () => { this.hide(); this.emit('close'); });
    this.el.all.addEventListener('click', () => { this.hide(); this.emit('grid'); });
    this.el.fav.addEventListener('click', async () => { if (!this.record) return; this.record = await this.library.update(this.record.id, { favorite: !this.record.favorite }); this.list[this.index] = this.record; this.renderFav(); });
    this.el.share.addEventListener('click', () => this.save());
    this.el.del.addEventListener('click', () => this.remove());
    this.el.adjust.addEventListener('click', () => { const open = this.el.pane.hidden; this.el.pane.hidden = !open; this.el.adjust.setAttribute('aria-pressed', String(open)); this.el.looks.hidden = open; this.el.frames.hidden = open; });
    this.el.looks.addEventListener('click', (ev) => { const b = ev.target.closest('.look'); if (b) { this.setLook(b.dataset.id); this.persist(); } });
    this.el.frames.addEventListener('click', (ev) => { const b = ev.target.closest('.frame-opt'); if (b) { this.setFrame(b.dataset.id); this.settings?.set('frame', b.dataset.id); this.persist(); } });
    this.el.strength.addEventListener('input', () => { this.strength = parseFloat(this.el.strength.value); this.el.strengthV.textContent = `${Math.round(this.strength * 100)}%`; this.scheduleRender(); this.persist(); });
    $('rvAuto').addEventListener('click', () => this.auto());
    $('rvResetEdit').addEventListener('click', () => { this.adjust = { ...ADJUST_DEFAULTS }; this.depth = this.record?.mask ? (this.record.meta?.depthDefault ?? 0.6) : 0; this.strength = 1; this.syncSliders(); this.scheduleRender(); this.persist(); });
    this.bindSwipe();
    document.addEventListener('keydown', (e) => {
      if (this.el.root.hidden || e.target.tagName === 'INPUT') return;
      if (e.key === 'ArrowLeft') this.go(-1); else if (e.key === 'ArrowRight') this.go(1); else if (e.key === 'Escape') { this.hide(); this.emit('close'); }
    });
  }

  get isOpen() { return !this.el.root.hidden; }

  buildFrames() {
    for (const f of FRAMES) {
      const b = document.createElement('button'); b.className = 'frame-opt'; b.dataset.id = f.id;
      b.innerHTML = `<i></i><span>${f.name}</span>`; this.el.frames.appendChild(b);
    }
  }

  /** Look thumbnails rendered from the current photo (square crop, tiny, GPU). */
  buildLooks() {
    const strip = this.el.looks; strip.innerHTML = '';
    const first = ['natural', 'clean', 'harbor', 'dusk', 'relic', 'pop', 'cinematic'];
    const order = [...first, ...FILTERS.map((f) => f.id).filter((id) => !first.includes(id))];
    const S = 108, bm = this.bitmap;
    const base = document.createElement('canvas'); base.width = S; base.height = S;
    const side = Math.min(bm.width, bm.height);
    base.getContext('2d').drawImage(bm, (bm.width - side) / 2, (bm.height - side) / 2, side, side, 0, 0, S, S);
    for (const id of order) {
      const f = FILTERS.find((x) => x.id === id); if (!f) continue;
      const b = document.createElement('button'); b.className = 'look'; b.dataset.id = id; b.setAttribute('role', 'option');
      const thumb = renderStill(base, { lookId: id }); thumb.className = 'ph';
      const span = document.createElement('span'); span.textContent = f.name;
      b.append(thumb, span);
      if (id === this.recommended && id !== 'natural') b.classList.add('recommended');
      strip.appendChild(b);
    }
  }

  /** Open on a record (or the newest photo when none is given). */
  async show(record = null, { recommendedFilter = null, initialFilter = null, strength = null } = {}) {
    this.list = await this.library.all();
    if (!this.list.length) { this.toast.show('No photos yet'); return false; }
    this.index = Math.max(0, record ? this.list.findIndex((r) => r.id === record.id) : 0);
    this.el.root.hidden = false;
    this.el.pane.hidden = true; this.el.adjust.setAttribute('aria-pressed', 'false'); this.el.looks.hidden = false; this.el.frames.hidden = false;
    await this.load(this.index, { recommendedFilter, initialFilter, strength });
    try {
      if (this.list.length > 1 && !localStorage.getItem('smart-camera.swipe-hint')) { this.toast.show('Swipe to browse · swipe down for the camera', 3000); localStorage.setItem('smart-camera.swipe-hint', '1'); }
    } catch { /* private mode */ }
    return true;
  }

  async load(i, { recommendedFilter = null, initialFilter = null, strength = null } = {}) {
    this.index = i;
    this.record = this.list[i];
    const m = this.record.meta || {};
    this.recommended = recommendedFilter || m.filter || 'natural';
    this.strength = strength ?? m.strength ?? 1;
    this.el.strength.value = this.strength; this.el.strengthV.textContent = `${Math.round(this.strength * 100)}%`;
    const styleName = m.style && m.style !== 'standard' ? m.style : null;
    const bits = [styleName, m.subject, m.scene, m.portrait ? 'depth' : null, m.burst ? `best of ${m.burst}` : null, m.selfie ? 'selfie' : null].filter(Boolean);
    this.el.meta.textContent = [...new Set(bits)].join('  ·  ');
    this.el.counter.textContent = `${i + 1} / ${this.list.length}`;
    this.renderFav();
    this.adjust = { ...ADJUST_DEFAULTS, ...(m.adjust || {}) };
    this.depth = this.record.mask ? (m.depth ?? 0.6) : 0;
    this.syncSliders();
    this.bitmap?.close?.(); this.maskBitmap?.close?.(); this.maskBitmap = null;
    this.bitmap = await createImageBitmap(this.record.blob);
    if (this.record.mask) this.maskBitmap = await createImageBitmap(this.record.mask);
    this.buildLooks();
    this.frame = m.frame || this.settings?.get('frame') || 'none';
    this.markFrame();
    this.setLook(initialFilter || m.look || 'natural');
  }

  hide() {
    this.el.root.hidden = true;
    if (this.url) { URL.revokeObjectURL(this.url); this.url = null; }
    this.bitmap?.close?.(); this.bitmap = null; this.maskBitmap?.close?.(); this.maskBitmap = null;
    this.el.img.removeAttribute('src');
  }

  renderFav() { this.el.fav.textContent = this.record?.favorite ? '♥' : '♡'; this.el.fav.setAttribute('aria-pressed', String(!!this.record?.favorite)); }

  setLook(id) {
    this.look = id;
    for (const b of this.el.looks.querySelectorAll('.look')) b.classList.toggle('active', b.dataset.id === id);
    this.el.looks.querySelector('.look.active')?.scrollIntoView?.({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    this.scheduleRender(0);
  }

  setFrame(id) { this.frame = id; this.markFrame(); this.scheduleRender(0); }
  markFrame() { for (const b of this.el.frames.querySelectorAll('.frame-opt')) b.classList.toggle('active', b.dataset.id === this.frame); }

  persist() {
    clearTimeout(this._p);
    const rec = this.record, patch = { look: this.look, strength: this.strength, adjust: { ...this.adjust }, depth: this.depth, frame: this.frame };
    this._p = setTimeout(async () => {
      const updated = await this.library.update(rec.id, { meta: { ...(rec.meta || {}), ...patch } }).catch(() => null);
      if (updated) { const i = this.list.findIndex((r) => r.id === rec.id); if (i >= 0) this.list[i] = updated; if (this.record?.id === rec.id) this.record = updated; }
    }, 300);
  }

  renderOptions() {
    return { lookId: this.look, strength: this.strength, adjust: this.adjust, depth: this.maskBitmap && this.depth > 0 ? { mask: this.maskBitmap, amount: this.depth } : null };
  }

  frameInfo() {
    const m = this.record?.meta || {};
    return { date: new Date(m.takenAt || this.record?.createdAt || Date.now()), device: this.settings?.get('deviceName') || 'iPhone', specs: specsLine(m), focusY: m.focusY ?? 0.5 };
  }

  isEdited() {
    return (this.look !== 'natural' && this.strength > 0) || this.frame !== 'none' || Object.keys(ADJUST_DEFAULTS).some((k) => Math.abs(this.adjust[k] || 0) > 1e-3) || (this.maskBitmap && this.depth > 0);
  }

  buildEditor() {
    const grid = $('editSliders'); this.sliders = {};
    for (const [key, label] of SLIDERS) {
      const name = document.createElement('span'); name.textContent = label;
      const input = document.createElement('input'); input.type = 'range'; input.step = '0.01';
      input.min = key === 'depth' || key === 'vignette' ? '0' : '-1'; input.max = '1'; input.setAttribute('aria-label', label);
      const val = document.createElement('b');
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        if (key === 'depth') this.depth = v; else this.adjust[key] = v;
        val.textContent = this.sliderText(key, v); this.scheduleRender(); this.persist();
      });
      grid.append(name, input, val);
      this.sliders[key] = { name, input, val };
    }
  }

  sliderText(key, v) { return key === 'depth' ? `f/${(16 * Math.pow(1.4 / 16, v)).toFixed(1)}` : `${v > 0 ? '+' : ''}${Math.round(v * 100)}`; }

  syncSliders() {
    for (const [key, s] of Object.entries(this.sliders || {})) {
      const v = key === 'depth' ? this.depth : (this.adjust[key] ?? 0);
      s.input.value = v; s.val.textContent = this.sliderText(key, v);
      const hide = key === 'depth' && !this.record?.mask;
      s.name.hidden = hide; s.input.hidden = hide; s.val.hidden = hide;
    }
  }

  auto() {
    if (!this.bitmap) return;
    const c = document.createElement('canvas'); const k = 256 / Math.max(this.bitmap.width, this.bitmap.height);
    c.width = Math.max(1, Math.round(this.bitmap.width * k)); c.height = Math.max(1, Math.round(this.bitmap.height * k));
    const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(this.bitmap, 0, 0, c.width, c.height);
    this.adjust = { ...this.adjust, ...autoEnhance(ctx.getImageData(0, 0, c.width, c.height)) };
    this.syncSliders(); this.scheduleRender(); this.persist();
    this.toast.show('Auto-enhanced', 1200);
  }

  async remove() {
    if (!this.record) return;
    if (!confirm('Delete this photo from Smart Camera? Copies you already saved to Photos are not affected.')) return;
    const id = this.record.id;
    await this.library.remove(id);
    this.list.splice(this.index, 1);
    this.emit('deleted', { id, remaining: this.list.length });
    if (!this.list.length) { this.hide(); this.emit('close'); return; }
    await this.load(Math.min(this.index, this.list.length - 1));
  }

  scheduleRender(delay = 30) { clearTimeout(this._t); this._t = setTimeout(() => this.render(), delay); }

  async render() {
    if (!this.bitmap) return;
    const token = ++this.renderToken;
    this.el.img.classList.add('busy');
    const side = Math.min(2048, Math.round(Math.max(window.innerWidth, window.innerHeight) * Math.min(2, window.devicePixelRatio || 1)));
    const canvas = applyFrame(renderStill(this.bitmap, { ...this.renderOptions(), maxSide: side }), this.frame, this.frameInfo());
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
    if (token !== this.renderToken || !blob) return;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(blob);
    this.el.img.src = this.url;
    this.el.img.classList.remove('busy');
  }

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

  /** Save: full-resolution export with look, edits, depth and frame → share sheet / download. */
  async save() {
    if (!this.record) return;
    let blob = this.record.blob;
    const name = `SmartCamera-${new Date(this.record.createdAt).toISOString().replace(/[:.]/g, '-')}${this.look !== 'natural' ? `-${this.look}` : ''}.jpg`;
    if (this.isEdited()) {
      this.toast.show('Preparing photo…');
      const canvas = applyFrame(renderStill(this.bitmap || await createImageBitmap(this.record.blob), this.renderOptions()), this.frame, this.frameInfo());
      blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.95));
    }
    const result = await PhotoLibrary.export(blob, name);
    if (result === 'downloaded') this.toast.show('Saved to your downloads');
    else if (result === 'shared') this.toast.show('Saved');
  }
}
