/**
 * Hands-free capture triggers. Both are pure state machines driven by the
 * per-frame analysis, so they are easy to test and cost nothing extra to run.
 */

/** Fires once when `active` has been true for holdMs, then waits cooldownMs. */
export class HoldTrigger {
  constructor({ holdMs = 500, cooldownMs = 4000 } = {}) { this.holdMs = holdMs; this.cooldownMs = cooldownMs; this.since = null; this.blockedUntil = 0; this.progress = 0; }
  update(active, now) {
    if (now < this.blockedUntil) { this.since = null; this.progress = 0; return false; }
    if (!active) { this.since = null; this.progress = 0; return false; }
    if (this.since == null) this.since = now;
    this.progress = Math.min(1, (now - this.since) / this.holdMs);
    if (now - this.since >= this.holdMs) { this.since = null; this.progress = 0; this.blockedUntil = now + this.cooldownMs; return true; }
    return false;
  }
  block(now, ms = this.cooldownMs) { this.blockedUntil = now + ms; this.since = null; }
}

/**
 * Raised hand: a confidently visible wrist above the top of the head, with its
 * elbow above the shoulder (a clear, deliberate gesture rather than a touch of the hair).
 */
export function handRaised(subject) {
  const l = subject?.landmarks;
  if (!l || subject.coasting) return false;
  const vis = (p) => (p?.visibility ?? 0) >= 0.55;
  const top = subject.headTopY ?? l[0].y;
  for (const [w, e, s] of [[15, 13, 11], [16, 14, 12]]) {
    if (vis(l[w]) && vis(l[e]) && l[w].y < top && l[e].y < l[s].y) return true;
  }
  return false;
}

/** Smiling: the subject's face smile score above a threshold. */
export const isSmiling = (expr, threshold = 0.55) => !!expr && expr.smile >= threshold;
