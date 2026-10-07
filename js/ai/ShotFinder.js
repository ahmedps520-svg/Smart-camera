import { Emitter } from '../util/events.js';
import { AI_STYLES } from '../config/defaults.js';

/**
 * ✦ Find the shot — one tap, one frame, one box.
 *
 *  PLAN    analyse the frame you were looking at when you tapped (a single
 *          fresh analysis frame) and decide the best framing for the style.
 *  AIM     a yellow box marks that framing, with a line from the centre of the
 *          screen to it. The box is glued to the scene (camera-motion estimate),
 *          so it does not wander. Move the phone until the box is centred.
 *  ZOOM    zoom so the box fills the frame (style decides how far), then shoot.
 *
 * If the box is not lined up within aimTimeoutMs, the photo is taken anyway and
 * cropped to the box — you always get the AI's framing, quickly.
 * Events: 'zoom' {zoom}, 'capture' {label, crop|null, focusY}, 'end' {reason}
 */
export const FINDER = {
  alignTol: 0.075,       // box centre this close to the screen centre counts as lined up
  alignHoldMs: 220,
  zoomSettleMs: 450,
  aimTimeoutMs: 4000,
  planTimeoutMs: 1500,   // if no complete analysis frame arrives, plan with what we have
  repositionBelow: 1.12, // zoom ratios below this only reposition (no zoom)
};

const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const clamp = (v, a, z) => Math.min(z, Math.max(a, v));

/**
 * Best framing for the current frame and style (pure).
 * @returns {{box, targetZoom, label, kind, subject, zoomOutFirst?}}
 *   box: the framing in view coordinates (may extend past the edge); targetZoom:
 *   zoom that makes the box fill the frame once it is centred.
 */
export function planShot({ candidates = [], style = AI_STYLES[0], current = 1, presets = [] } = {}) {
  const st = { ...AI_STYLES[0], ...style };
  const weight = (c) => c.score * (st.weights?.[c.kind] ?? 1);
  const subject = candidates.slice().sort((a, b) => weight(b) - weight(a))[0] || null;
  const factors = presets.map((p) => p.factor).sort((a, b) => a - b);
  const minF = factors[0] ?? current, maxF = Math.min(st.maxZoom ?? Infinity, factors[factors.length - 1] ?? current);

  // 1. How far to zoom for this style.
  let desired;
  if (st.zoom === 'wide') desired = minF;
  else if (!subject) desired = current * Math.max(1, st.zoomScale ?? 1);
  else if (subject.kind === 'light') desired = current * 1.5 * (st.zoomScale ?? 1);
  else {
    const b = subject.box, size = Math.max(b.h, b.w * 0.75);
    const person = subject.kind === 'person' || subject.kind === 'group';
    const frac = person ? (st.personFrac ?? 0.6) : b.w * b.h < 0.012 ? 0.16 : 0.32;
    desired = current * (frac / Math.max(0.005, size)) * (st.zoomScale ?? 1);
  }
  desired = clamp(desired, minF, Math.max(minF, maxF));
  // Optical lenses where they fit (Cinematic/Snapchat keep exact continuous zoom).
  if (!st.continuous && factors.length) { let pick = minF; for (const f of factors) if (f <= desired * 1.05 && f <= maxF) pick = f; desired = pick; }
  else for (const f of factors) if (Math.abs(f - desired) / desired < 0.08) desired = f;

  if (desired < current * 0.95) return { zoomOutFirst: desired, subject, label: subject?.label || 'best framing', kind: subject?.kind || 'scene' };

  // 2. Size of the framing box (same shape as the screen).
  let ratio = desired / current;
  const reposition = ratio < FINDER.repositionBelow;
  let s = reposition ? 0.86 : 1 / ratio;
  // Keep the whole subject in the box unless the style likes tight crops.
  if (subject && !st.allowCrop && subject.kind !== 'light') {
    const need = Math.max(subject.box.w, subject.box.h) / 0.9;
    if (need > s) { s = Math.min(0.95, need); ratio = 1 / s; }
  }

  // 3. Where the subject sits inside the box.
  const faceFirst = st.faceAim != null && subject?.head;
  const pt = subject ? (faceFirst ? subject.head : center(subject.box)) : { x: 0.5, y: 0.5 };
  let ax = 0.5;
  if (subject && st.aim === 'thirds' && subject.box.w < 0.55 * s) ax = pt.x < 0.5 ? 1 / 3 : 2 / 3;
  let ay = 0.5;
  if (faceFirst) ay = st.faceAim;
  else if (subject && (subject.kind === 'person' || subject.kind === 'group')) ay = st.personAimY ?? 0.55;
  else if (subject?.kind === 'light') ay = st.lightAimY ?? 0.5;
  const box = { x: pt.x - ax * s, y: pt.y - ay * s, w: s, h: s };
  // The box centre must be reachable on screen.
  const c = center(box);
  box.x += clamp(c.x, 0.12, 0.88) - c.x; box.y += clamp(c.y, 0.12, 0.88) - c.y;

  const targetZoom = reposition ? current : Math.round(current * ratio * 10) / 10;
  return { box, targetZoom, label: subject?.label || 'best framing', kind: subject?.kind || 'scene', subject };
}

export class ShotFinder extends Emitter {
  constructor(config = FINDER) { super(); this.config = { ...FINDER, ...config }; this.reset(); }

  reset() { this.state = 'IDLE'; this.plan = null; this.box = null; this.startedAt = 0; this.aimStart = 0; this.alignedSince = 0; this.zoomAt = 0; this.replanned = false; }

  get active() { return this.state !== 'IDLE'; }
  get target() { return this.plan ? { box: this.box, label: this.plan.label, kind: this.plan.kind } : null; }

  start(now, style = AI_STYLES[0]) { this.reset(); this.style = { ...AI_STYLES[0], ...style }; this.state = 'PLAN'; this.startedAt = now; }

  cancel(reason = 'cancelled') { const was = this.state; this.reset(); if (was !== 'IDLE') this.emit('end', { reason }); }

  /**
   * @param input { candidates, fresh (complete analysis frame), shift {dx,dy,ok}, zoom {current, presets} }
   */
  update(input, now) {
    const C = this.config;
    const { candidates = [], fresh = true, shift = null, zoom = { current: 1, presets: [] } } = input;
    const vm = { state: this.state, message: null, tone: 'yellow', box: null, label: null, progress: 0 };

    if (this.state === 'PLAN') {
      vm.message = 'Analysing the frame...';
      if (this.replanned && now - this.startedAt < C.zoomSettleMs) { vm.message = 'Going wide...'; return vm; }
      if (!fresh && now - this.startedAt < C.planTimeoutMs) return vm;
      const plan = planShot({ candidates, style: this.style, current: zoom.current, presets: zoom.presets });
      if (plan.zoomOutFirst && !this.replanned) {
        // Widen first (e.g. Scenic), then plan again on the wider view.
        this.replanned = true; this.startedAt = now; this.emit('zoom', { zoom: plan.zoomOutFirst });
        vm.message = 'Going wide...'; return vm;
      }
      this.plan = plan.zoomOutFirst ? { ...plan, box: { x: 0.07, y: 0.07, w: 0.86, h: 0.86 }, targetZoom: zoom.current } : plan;
      this.box = { ...this.plan.box };
      this.state = 'AIM'; this.aimStart = now; this.alignedSince = 0;
    }

    if (this.state === 'AIM') {
      // Keep the box on the same spot in the scene as the phone moves.
      if (shift?.ok) { this.box.x += shift.dx; this.box.y += shift.dy; }
      const c = center(this.box), dx = c.x - 0.5, dy = c.y - 0.5, off = Math.hypot(dx, dy);
      vm.state = 'AIM'; vm.box = this.box; vm.label = this.plan.label;
      vm.progress = Math.min(1, (now - this.aimStart) / C.aimTimeoutMs);
      if (off <= C.alignTol) {
        if (!this.alignedSince) this.alignedSince = now;
        vm.aligned = true; vm.tone = 'green'; vm.message = 'Hold it there...';
        if (now - this.alignedSince >= C.alignHoldMs) {
          const z = this.plan.targetZoom;
          if (Math.abs(z - zoom.current) / zoom.current > 0.03) { this.state = 'ZOOM'; this.zoomAt = now; this.emit('zoom', { zoom: z }); vm.state = 'ZOOM'; vm.message = `Zooming to ${+z.toFixed(1)}×...`; return vm; }
          return this.finish(vm, null);
        }
        return vm;
      }
      this.alignedSince = 0;
      if (now - this.aimStart >= C.aimTimeoutMs) return this.finish(vm, this.box);
      vm.message = Math.abs(dx) >= Math.abs(dy) ? `Move your phone ${dx < 0 ? 'left' : 'right'} to the box` : `Move your phone ${dy < 0 ? 'up' : 'down'} to the box`;
      return vm;
    }

    if (this.state === 'ZOOM') {
      vm.state = 'ZOOM'; vm.tone = 'green'; vm.message = `Zooming to ${+this.plan.targetZoom.toFixed(1)}×...`;
      if (now - this.zoomAt >= C.zoomSettleMs) return this.finish(vm, null);
    }
    return vm;
  }

  /** Take the picture. crop = box to crop to (timeout fallback), or null when the zoom framed it. */
  finish(vm, crop) {
    const plan = this.plan, sub = plan.subject;
    // Subject height inside the final photo (the box), for a later Cinema crop.
    const py = sub ? (sub.head ? sub.head.y : sub.box.y + sub.box.h / 2) : plan.box.y + plan.box.h / 2;
    const focusY = Math.min(1, Math.max(0, (py - plan.box.y) / plan.box.h));
    const c = crop ? { ...crop } : null;
    const label = plan.label;
    this.reset();
    this.emit('capture', { label, crop: c, focusY });
    return { ...vm, state: 'CAPTURE', message: 'Got it', tone: 'green' };
  }
}
