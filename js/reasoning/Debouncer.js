/**
 * Guidance debouncer with hysteresis. A new message must persist for
 * `confirmMs` before it replaces the current one, and the current one is held
 * for at least `minHoldMs` unless a higher-severity message arrives.
 * Prevents LEFT / RIGHT / LEFT flicker.
 */
export class Debouncer {
  constructor({ minHoldMs = 900, confirmMs = 320 } = {}) {
    this.minHoldMs = minHoldMs; this.confirmMs = confirmMs;
    this.current = null; this.shownAt = 0;
    this.pending = null; this.pendingSince = 0;
  }

  /** @param {{code:string, severity?:number}|null} rec @returns current recommendation */
  push(rec, now) {
    const code = rec?.code ?? null;
    if (code === (this.current?.code ?? null)) { this.pending = null; if (rec) this.current = { ...rec, since: this.current.since }; return this.current; }
    if (this.pending?.code !== code) { this.pending = rec; this.pendingSince = now; }
    const held = now - this.shownAt;
    const sev = rec?.severity ?? 0, curSev = this.current?.severity ?? 0;
    const confirmed = now - this.pendingSince >= this.confirmMs;
    const urgent = sev > curSev + 1 && now - this.pendingSince >= this.confirmMs / 2;
    if ((confirmed && held >= this.minHoldMs) || urgent || (this.current == null && confirmed)) {
      this.current = rec ? { ...rec, since: now } : null;
      this.shownAt = now; this.pending = null;
    }
    return this.current;
  }

  reset() { this.current = null; this.pending = null; this.shownAt = 0; }
}

/**
 * Per-key Schmitt trigger: an issue becomes active when its magnitude exceeds
 * `tol * enter` and stays active until it drops below `tol * exit`.
 */
export class Hysteresis {
  constructor({ enter = 1.0, exit = 0.6 } = {}) { this.enter = enter; this.exit = exit; this.active = new Set(); }
  test(key, magnitude, tol) {
    const on = this.active.has(key);
    if (!on && magnitude > tol * this.enter) { this.active.add(key); return true; }
    if (on && magnitude < tol * this.exit) { this.active.delete(key); return false; }
    return on;
  }
  clear(key) { this.active.delete(key); }
  reset() { this.active.clear(); }
}
