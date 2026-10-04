import { OneEuroBox } from '../util/smoothing.js';
import { GUIDANCE } from '../config/defaults.js';

const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [0, 11], [0, 12]];

/**
 * Draws all on-preview guidance on a canvas: dynamic composition box, subject
 * box, skeleton (optional), grid, horizon/level guide and group markers.
 * Coordinates arrive normalised to the video frame; this class maps them to the
 * object-fit: cover preview (including digital zoom and mirroring).
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

  /** Mapping from normalised frame coords to CSS pixels (object-fit: contain + digital zoom). */
  mapper() {
    const vw = this.video.videoWidth || 4, vh = this.video.videoHeight || 3;
    const z = this.options.zoom || 1;
    const scale = Math.min(this.w / vw, this.h / vh) * z;
    const dw = vw * scale, dh = vh * scale;
    const ox = (this.w - dw) / 2, oy = (this.h - dh) / 2;
    const mirror = this.options.mirror;
    return {
      x: (nx) => ox + (mirror ? 1 - nx : nx) * dw,
      y: (ny) => oy + ny * dh,
      box: (b) => ({ x: ox + (mirror ? 1 - b.x - b.w : b.x) * dw, y: oy + b.y * dh, w: b.w * dw, h: b.h * dh }),
    };
  }

  clear() { this.ctx.clearRect(0, 0, this.w, this.h); }

  /**
   * @param {Object} s { tracked, composition, motion, recommendation, mode, aligned, holdProgress, now }
   */
  draw(s) {
    const ctx = this.ctx; this.clear();
    const m = this.mapper();
    if (this.options.grid) this.drawGrid(ctx);
    if (this.options.horizon && s.motion?.available) this.drawHorizon(ctx, s.motion);
    const tracked = s.tracked;
    const aiOn = s.mode !== 'photo';
    if (!aiOn) { this.targetFilter.reset(); this.subjectFilter.reset(); return; }

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

  drawGrid(ctx) {
    ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 0.8;
    for (const f of [1 / 3, 2 / 3]) { ctx.beginPath(); ctx.moveTo(this.w * f, 0); ctx.lineTo(this.w * f, this.h); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, this.h * f); ctx.lineTo(this.w, this.h * f); ctx.stroke(); }
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
