import { OneEuroBox } from '../util/smoothing.js';
import { GUIDANCE } from '../config/defaults.js';

const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [0, 11], [0, 12]];

/**
 * Draws all on-preview guidance on a canvas: dynamic composition box, subject
 * box, skeleton (optional), grid, horizon/level guide and group markers.
 * Coordinates arrive normalised to the visible view (see vision/ViewTransform.js).
 */
export class Overlay {
  constructor(canvas, video) {
    this.canvas = canvas; this.video = video; this.ctx = canvas.getContext('2d');
    this.targetFilter = new OneEuroBox({ minCutoff: 0.8, beta: 0.01 });
    this.subjectFilter = new OneEuroBox({ minCutoff: 1.6, beta: 0.05 });
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.options = { grid: false, horizon: true, skeleton: false, mirror: false, zoom: 1 };
    this.alignedPulse = 0;
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(this.w * this.dpr); this.canvas.height = Math.round(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /**
   * Mapping from normalised view coordinates (0..1 across the visible
   * viewfinder, as produced by ViewTransform) to CSS pixels. The preview is
   * mirrored for the front camera, so x is flipped to match.
   */
  mapper() {
    const w = this.w, h = this.h, mirror = this.options.mirror;
    return {
      x: (nx) => (mirror ? 1 - nx : nx) * w,
      y: (ny) => ny * h,
      box: (b) => ({ x: (mirror ? 1 - b.x - b.w : b.x) * w, y: b.y * h, w: b.w * w, h: b.h * h }),
    };
  }

  clear() { this.ctx.clearRect(0, 0, this.w, this.h); }

  /**
   * @param {Object} s { tracked, composition, motion, recommendation, mode, aligned, holdProgress, now }
   */
  draw(s) {
    const ctx = this.ctx; this.clear();
    if (this.options.letterbox) this.drawLetterbox(ctx);
    const m = this.mapper();
    if (this.options.grid && this.options.grid !== 'off') this.drawGrid(ctx, this.options.grid);
    if (this.options.horizon && s.motion?.available && !s.motion.flat) this.drawHorizon(ctx, s.motion);
    if (s.finder) { this.drawFinder(s.finder, m, s.now); return; }
    const tracked = s.tracked;
    const aiOn = s.mode !== 'photo';
    if (!aiOn) { this.targetFilter.reset(); this.subjectFilter.reset(); return; }
    if (s.mode === 'smart') { this.drawSmartPhoto(s, m); return; }

    // Other people (group): light markers.
    if (tracked?.subjects?.length > 1) {
      for (const sub of tracked.subjects) { if (sub === tracked.primary) continue; const b = m.box(sub.box); this.roundRect(ctx, b, 10, 'rgba(255,255,255,0.35)', 1); }
    }
    if (this.options.skeleton && tracked?.subjects) for (const sub of tracked.subjects) if (sub.landmarks) this.drawSkeleton(ctx, sub.landmarks, m);

    // Subject box (smoothed) and target box.
    const comp = s.composition;
    const subjectBox = tracked?.count > 1 && tracked.groupBox ? tracked.groupBox : tracked?.primary?.smoothBox;
    const target = comp?.targetBox;
    if (subjectBox) {
      const sb = this.subjectFilter.push(m.box(subjectBox), s.now);
      ctx.save(); ctx.setLineDash([6, 6]); this.roundRect(ctx, sb, 12, 'rgba(255,255,255,0.55)', 1.2); ctx.restore();
    } else this.subjectFilter.reset();
    if (target) {
      const tb = this.targetFilter.push(m.box(target), s.now);
      const good = s.aligned;
      const color = good ? '82,210,115' : '255,184,77';
      const alpha = good ? 0.95 : 0.85;
      this.corners(ctx, tb, 22, `rgba(${color},${alpha})`, good ? 3 : 2.2);
      if (good) { ctx.save(); ctx.strokeStyle = `rgba(${color},0.35)`; ctx.lineWidth = 1; this.roundRect(ctx, tb, 14, `rgba(${color},0.3)`, 1); ctx.restore(); }
      // Label inside the box.
      ctx.save(); ctx.font = '600 11px -apple-system, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = `rgba(${color},0.9)`; ctx.letterSpacing = '0.14em';
      const label = good ? 'PERFECT' : (comp?.hasSubject ? 'SUBJECT HERE' : (comp?.type === 'CENTER' ? 'CENTRE SUBJECT' : ''));
      if (label) ctx.fillText(label, tb.x + tb.w / 2, tb.y + tb.h + 16);
      ctx.restore();
      // Hold/countdown progress ring at the box centre.
      if (s.holdProgress > 0) {
        ctx.save(); ctx.beginPath(); ctx.lineWidth = 3; ctx.strokeStyle = `rgba(${color},0.9)`; ctx.lineCap = 'round';
        ctx.arc(tb.x + tb.w / 2, tb.y + tb.h / 2, 22, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * s.holdProgress); ctx.stroke(); ctx.restore();
      }
    } else this.targetFilter.reset();
    // Horizon line estimate for landscapes.
    if (comp?.horizon && !comp.hasSubject) { ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.setLineDash([4, 8]); ctx.lineWidth = 1; const y = m.y(comp.horizon.y); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.w, y); ctx.stroke(); ctx.restore(); }
  }

  /**
   * Smart Photo: one clear yellow ring around the subject and one small
   * instruction next to it. Nothing else.
   * s.ring = { box, coasting, perfect, label: {text, arrow} | null, color }
   */
  drawSmartPhoto(s, m) {
    const ctx = this.ctx, r = s.ring;
    if (!r?.box) { this.subjectFilter.reset(); this.ringAlpha = 0; return; }
    const raw = m.box(r.box);
    const pad = Math.max(10, Math.min(raw.w, raw.h) * 0.08);
    const b = this.subjectFilter.push({ x: raw.x - pad, y: raw.y - pad, w: raw.w + pad * 2, h: raw.h + pad * 2 }, s.now);
    // Keep the ring on screen even when the subject is partly out of frame.
    const x = Math.max(4, b.x), y = Math.max(4, b.y);
    const box = { x, y, w: Math.min(this.w - 4, b.x + b.w) - x, h: Math.min(this.h - 4, b.y + b.h) - y };
    if (box.w < 8 || box.h < 8) return;
    this.ringAlpha = Math.min(1, (this.ringAlpha || 0) + 0.15);
    const alpha = this.ringAlpha * (r.coasting ? 0.55 : 1);
    const color = r.color || '#FFD60A';
    const radius = Math.min(box.w, box.h) / 2;
    if (!r.hideRing) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color; ctx.lineWidth = r.perfect ? 4 : 3;
    ctx.shadowColor = r.perfect ? color : 'rgba(0,0,0,0.55)'; ctx.shadowBlur = r.perfect ? 14 : 6;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(box.x, box.y, box.w, box.h, radius); else ctx.rect(box.x, box.y, box.w, box.h);
    ctx.stroke();
    ctx.restore();
    }

    // Direction chevron on the ring edge.
    const dir = { '←': [-1, 0], '→': [1, 0], '↑': [0, -1], '↓': [0, 1] }[r.label?.arrow];
    if (dir && !r.perfect && !r.hideRing) {
      const cx = box.x + box.w / 2 + dir[0] * (box.w / 2 + 16), cy = box.y + box.h / 2 + dir[1] * (box.h / 2 + 16);
      const px = Math.min(this.w - 14, Math.max(14, cx)), py = Math.min(this.h - 14, Math.max(14, cy));
      const ang = Math.atan2(dir[1], dir[0]);
      ctx.save(); ctx.globalAlpha = alpha; ctx.fillStyle = color; ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 4;
      ctx.translate(px, py); ctx.rotate(ang);
      ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(-6, -8); ctx.lineTo(-2, 0); ctx.lineTo(-6, 8); ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    // Small instruction label under the ring (or above it if there is no room).
    const text = r.perfect ? '✓ Perfect' : r.label?.text;
    if (!text) return;
    ctx.save();
    ctx.font = '600 13px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
    const tw = ctx.measureText(text).width;
    const lw = tw + 20, lh = 26;
    let lx = box.x + box.w / 2 - lw / 2;
    lx = Math.min(this.w - lw - 8, Math.max(8, lx));
    const below = box.y + box.h + 10;
    const bottomLimit = this.h - (this.bottomInset || 220);
    let ly = below + lh <= bottomLimit ? below : box.y - lh - 10;
    if (ly < (this.topInset || 110)) ly = Math.min(bottomLimit - lh, box.y + 12);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(lx, ly, lw, lh, lh / 2); else ctx.rect(lx, ly, lw, lh); ctx.fill();
    ctx.fillStyle = r.perfect ? color : '#fff';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, lx + lw / 2, ly + lh / 2 + 0.5);
    ctx.restore();
  }

  /** Cinematic: dim everything outside a centred 2.39:1 band (what the Cinema frame keeps). */
  drawLetterbox(ctx) {
    const bh = Math.min(this.h, this.w / 2.39), y = (this.h - bh) / 2;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, this.w, y); ctx.fillRect(0, y + bh, this.w, this.h - y - bh);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(this.w, y + 0.5); ctx.moveTo(0, y + bh - 0.5); ctx.lineTo(this.w, y + bh - 0.5); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.font = '600 10px -apple-system, system-ui, sans-serif'; ctx.textAlign = 'right';
    ctx.fillText('2.39 : 1', this.w - 8, y - 6);
    ctx.restore();
  }

  /**
   * "Find the shot" overlay: the AI's framing as a yellow box glued to the
   * scene, a line with an arrowhead from the centre of the screen to it, and a
   * centre crosshair. Green once it is lined up.
   */
  drawFinder(vm, m, now) {
    const ctx = this.ctx;
    if (!vm?.box) { this.targetFilter.reset(); return; }
    const col = vm.aligned ? '#30D158' : '#FFD60A';
    const raw = m.box(vm.box);
    const b = this.targetFilter.push(raw, now);
    const vx = this.w / 2, vy = this.h / 2, px = b.x + b.w / 2, py = b.y + b.h / 2;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 6;
    // Box (clipped to the screen so a box partly off-screen still reads as a box).
    ctx.strokeStyle = col; ctx.lineWidth = 3;
    const x0 = Math.max(3, b.x), y0 = Math.max(3, b.y), x1 = Math.min(this.w - 3, b.x + b.w), y1 = Math.min(this.h - 3, b.y + b.h);
    if (x1 > x0 + 10 && y1 > y0 + 10) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x0, y0, x1 - x0, y1 - y0, 14) : ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.stroke(); }
    // Line from the centre of the screen toward the box, with an arrowhead.
    const d = Math.hypot(px - vx, py - vy);
    if (d > 24 && !vm.aligned) {
      const ang = Math.atan2(py - vy, px - vx);
      const ex = vx + Math.cos(ang) * (d - 10), ey = vy + Math.sin(ang) * (d - 10);
      ctx.strokeStyle = col; ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.setLineDash([7, 6]);
      ctx.beginPath(); ctx.moveTo(vx, vy); ctx.lineTo(ex, ey); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = col; ctx.beginPath();
      ctx.moveTo(ex + Math.cos(ang) * 10, ey + Math.sin(ang) * 10);
      ctx.lineTo(ex + Math.cos(ang + 2.5) * 12, ey + Math.sin(ang + 2.5) * 12);
      ctx.lineTo(ex + Math.cos(ang - 2.5) * 12, ey + Math.sin(ang - 2.5) * 12);
      ctx.closePath(); ctx.fill();
    }
    // Crosshairs: screen centre and box centre.
    const plus = (x, y, r) => { ctx.strokeStyle = col; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); ctx.stroke(); };
    plus(vx, vy, 8);
    if (px > 0 && px < this.w && py > 0 && py < this.h) plus(px, py, 6);
    // Label under (or inside) the box.
    if (vm.label) {
      ctx.font = '600 12px -apple-system, BlinkMacSystemFont, system-ui, sans-serif'; ctx.textBaseline = 'top';
      const tw = ctx.measureText(vm.label).width;
      const lx = Math.min(this.w - tw - 8, Math.max(8, x0 + 4));
      const ly = y1 + 6 + 16 < this.h ? y1 + 6 : y0 + 8;
      ctx.fillStyle = col; ctx.fillText(vm.label, lx, ly);
    }
    // Time left before the AI takes the shot anyway: a thin bar along the box's top edge.
    if (vm.progress > 0 && !vm.aligned && x1 > x0 + 10) {
      ctx.shadowBlur = 0; ctx.strokeStyle = 'rgba(255,214,10,0.55)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(x0 + 14, y0 - 6); ctx.lineTo(x0 + 14 + (x1 - x0 - 28) * (1 - vm.progress), y0 - 6); ctx.stroke();
    }
    ctx.restore();
  }

  /** Composition grids: rule of thirds, golden ratio (phi grid) or a centre cross. */
  drawGrid(ctx, type = 'thirds') {
    ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.24)'; ctx.lineWidth = 0.8;
    const line = (x0, y0, x1, y1) => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); };
    if (type === 'center') {
      const cx = this.w / 2, cy = this.h / 2, l = Math.min(this.w, this.h) * 0.06;
      line(cx - l, cy, cx + l, cy); line(cx, cy - l, cx, cy + l);
      ctx.strokeRect(this.w * 0.25, this.h * 0.25, this.w * 0.5, this.h * 0.5);
    } else {
      const fr = type === 'golden' ? [0.382, 0.618] : [1 / 3, 2 / 3];
      for (const f of fr) { line(this.w * f, 0, this.w * f, this.h); line(0, this.h * f, this.w, this.h * f); }
    }
    ctx.restore();
  }

  drawHorizon(ctx, motion) {
    const cx = this.w / 2, cy = this.h / 2, len = Math.min(this.w, this.h) * 0.28;
    const roll = motion.rollDeg || 0;
    ctx.save(); ctx.translate(cx, cy);
    // Fixed reference ticks.
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-len - 14, 0); ctx.lineTo(-len, 0); ctx.moveTo(len, 0); ctx.lineTo(len + 14, 0); ctx.stroke();
    // Rotating horizon line; green when level.
    ctx.rotate((roll * Math.PI) / 180);
    ctx.strokeStyle = motion.level ? 'rgba(82,210,115,0.95)' : 'rgba(255,255,255,0.8)'; ctx.lineWidth = motion.level ? 2 : 1.4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-len, 0); ctx.lineTo(len, 0); ctx.stroke();
    ctx.restore();
  }

  drawSkeleton(ctx, lm, m) {
    ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1.5; ctx.lineCap = 'round';
    for (const [a, b] of BONES) { const p = lm[a], q = lm[b]; if ((p.visibility ?? 1) < 0.45 || (q.visibility ?? 1) < 0.45) continue; ctx.beginPath(); ctx.moveTo(m.x(p.x), m.y(p.y)); ctx.lineTo(m.x(q.x), m.y(q.y)); ctx.stroke(); }
    ctx.fillStyle = 'rgba(255,184,77,0.9)';
    for (const i of [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) { const p = lm[i]; if ((p.visibility ?? 1) < 0.45) continue; ctx.beginPath(); ctx.arc(m.x(p.x), m.y(p.y), 2.5, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }

  roundRect(ctx, b, r, stroke, lw) {
    ctx.save(); ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(b.x, b.y, b.w, b.h, r) : ctx.rect(b.x, b.y, b.w, b.h); ctx.stroke(); ctx.restore();
  }

  corners(ctx, b, len, stroke, lw) {
    const L = Math.min(len, b.w / 3, b.h / 3);
    ctx.save(); ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 4;
    const c = [[b.x, b.y, 1, 1], [b.x + b.w, b.y, -1, 1], [b.x, b.y + b.h, 1, -1], [b.x + b.w, b.y + b.h, -1, -1]];
    for (const [x, y, sx, sy] of c) { ctx.beginPath(); ctx.moveTo(x, y + sy * L); ctx.lineTo(x, y); ctx.lineTo(x + sx * L, y); ctx.stroke(); }
    ctx.restore();
  }

  arrow(ctx, from, to, color) {
    const ang = Math.atan2(to.y - from.y, to.x - from.x);
    const len = Math.min(60, Math.hypot(to.x - from.x, to.y - from.y) * 0.5);
    const sx = from.x + Math.cos(ang) * 16, sy = from.y + Math.sin(ang) * 16;
    const ex = sx + Math.cos(ang) * len, ey = sy + Math.sin(ang) * len;
    ctx.save(); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex - Math.cos(ang - 0.5) * 10, ey - Math.sin(ang - 0.5) * 10); ctx.lineTo(ex - Math.cos(ang + 0.5) * 10, ey - Math.sin(ang + 0.5) * 10); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
}
