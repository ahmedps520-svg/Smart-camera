/** Synthesised UI sounds (no audio assets, works offline). */
export class Sounds {
  constructor() { this.ctx = null; this.enabled = true; }
  ensure() { if (!this.ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) this.ctx = new AC(); } if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {}); return this.ctx; }
  tone(freq, dur, { type = 'sine', gain = 0.08, at = 0 } = {}) {
    if (!this.enabled) return; const c = this.ensure(); if (!c) return;
    const o = c.createOscillator(), g = c.createGain(); o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0, c.currentTime + at); g.gain.linearRampToValueAtTime(gain, c.currentTime + at + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + at + dur);
    o.connect(g).connect(c.destination); o.start(c.currentTime + at); o.stop(c.currentTime + at + dur + 0.02);
  }
  shutter() { this.tone(1800, 0.05, { type: 'square', gain: 0.05 }); this.tone(900, 0.07, { type: 'triangle', gain: 0.06, at: 0.04 }); }
  tick() { this.tone(1200, 0.04, { gain: 0.04 }); }
  ready() { this.tone(880, 0.09, { gain: 0.05 }); this.tone(1320, 0.12, { gain: 0.05, at: 0.09 }); }
  cancel() { this.tone(400, 0.08, { type: 'triangle', gain: 0.03 }); }
}
