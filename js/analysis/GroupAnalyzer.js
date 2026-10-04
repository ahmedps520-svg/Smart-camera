import { COMPOSITION } from '../config/defaults.js';

/**
 * Multi-person checks: everyone in frame, spacing, balance, face visibility,
 * and whether the group has settled (no auto-capture until it has).
 * @returns {{everyoneInFrame:boolean, issues:[{code,text,severity}], stable:boolean, balance:number, spacing:number}}
 */
export class GroupAnalyzer {
  analyze(tracked, velocityThreshold = 0.03) {
    const subs = tracked.subjects;
    const issues = [];
    if (subs.length < 2) return { everyoneInFrame: true, issues, stable: true, balance: 1, spacing: 1 };
    const m = COMPOSITION.edgeMargin;
    const sorted = [...subs].sort((a, b) => a.center.x - b.center.x);
    let everyoneInFrame = true;
    for (const s of subs) {
      const cutL = s.box.x < m * 0.5, cutR = s.box.x + s.box.w > 1 - m * 0.5, cutT = s.headTopY < 0.005;
      if (cutL || cutR || cutT) {
        everyoneInFrame = false;
        const who = s === sorted[0] ? 'Person on the left' : s === sorted[sorted.length - 1] ? 'Person on the right' : 'Someone';
        issues.push({ code: cutT ? 'GROUP_HEAD_CUT' : 'GROUP_EDGE', severity: 2, text: cutT ? `${who} has their head cut off` : `${who} is too close to the edge` });
      }
      if (s.landmarks && !s.faceBox && (s.landmarks[0].visibility ?? 1) < 0.5) issues.push({ code: 'GROUP_FACE', severity: 1, text: 'Not every face is visible' });
    }
    const gb = tracked.groupBox;
    if (gb && (gb.w > 0.95 || gb.h > 0.95)) { everyoneInFrame = everyoneInFrame && gb.w <= 0.98; issues.push({ code: 'GROUP_BACK', severity: 2, text: 'Move back' }); }
    // Spacing: gaps between neighbours relative to average width.
    let gapsum = 0; const avgW = subs.reduce((s, x) => s + x.box.w, 0) / subs.length;
    for (let i = 1; i < sorted.length; i++) gapsum += Math.max(0, sorted[i].box.x - (sorted[i - 1].box.x + sorted[i - 1].box.w));
    const spacing = Math.min(1, 1 - Math.max(0, (gapsum / (sorted.length - 1)) / Math.max(0.05, avgW) - 1.2) * 0.5);
    if (spacing < 0.7) issues.push({ code: 'GROUP_SPREAD', severity: 1, text: 'Bring everyone closer together' });
    const gc = gb ? gb.x + gb.w / 2 : 0.5;
    const balance = Math.max(0, 1 - Math.abs(gc - 0.5) / 0.3);
    const stable = subs.every((s) => (s.velocity ?? 0) < velocityThreshold) && (tracked.primary?.velocity ?? 0) < velocityThreshold;
    if (!issues.length) issues.push({ code: 'GROUP_OK', severity: 0, text: 'Everyone is in frame' });
    return { everyoneInFrame, issues: issues.filter((i) => i.severity > 0 || issues.length === 1), stable, balance, spacing };
  }
}
