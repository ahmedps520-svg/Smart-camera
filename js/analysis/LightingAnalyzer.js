import { LIGHTING } from '../config/defaults.js';
import { clamp01 } from '../util/math.js';

/**
 * Local image-quality analysis from a small preview sample. This is a preview
 * heuristic, not a prediction of final image quality: it flags exposure, clipping,
 * contrast, backlighting, colour cast and (roughly) noise, and turns them into
 * short advice.
 */
export class LightingAnalyzer {
  constructor(config = LIGHTING) { this.config = config; this.last = null; }

  /**
   * @param {ImageData} img
   * @param {{box:{x,y,w,h}}|null} subject normalised subject box (for backlight detection)
   */
  analyze(img, subject = null, motionStability = 1) {
    if (!img) return this.last;
    const C = this.config;
    const { data, width: w, height: h } = img;
    const hist = new Uint32Array(32);
    let sum = 0, sumSq = 0, n = 0, rSum = 0, bSum = 0, gSum = 0, satSum = 0, hi = 0, lo = 0;
    let subSum = 0, subN = 0, bgSum = 0, bgN = 0, noise = 0, noiseN = 0;
    const sb = subject ? { x0: subject.box.x * w, y0: subject.box.y * h, x1: (subject.box.x + subject.box.w) * w, y1: (subject.box.y + subject.box.h) * h } : null;
    const Y = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4; const r = data[i], g = data[i + 1], b = data[i + 2];
        const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        Y[y * w + x] = l; sum += l; sumSq += l * l; n++;
        hist[Math.min(31, (l * 32) | 0)]++;
        rSum += r; gSum += g; bSum += b;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b); satSum += mx ? (mx - mn) / mx : 0;
        if (l > 0.97) hi++; else if (l < 0.03) lo++;
        if (sb) { if (x >= sb.x0 && x <= sb.x1 && y >= sb.y0 && y <= sb.y1) { subSum += l; subN++; } else { bgSum += l; bgN++; } }
      }
    }
    // Noise proxy: mean absolute Laplacian in low-gradient regions.
    for (let y = 1; y < h - 1; y += 2) {
      for (let x = 1; x < w - 1; x += 2) {
        const c = Y[y * w + x];
        const lap = Math.abs(4 * c - Y[y * w + x - 1] - Y[y * w + x + 1] - Y[(y - 1) * w + x] - Y[(y + 1) * w + x]);
        const grad = Math.abs(Y[y * w + x + 1] - Y[y * w + x - 1]) + Math.abs(Y[(y + 1) * w + x] - Y[(y - 1) * w + x]);
        if (grad < 0.08) { noise += lap; noiseN++; }
      }
    }
    const mean = sum / n;
    const contrast = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
    const highlights = hi / n, shadows = lo / n;
    const saturation = satSum / n;
    const warmth = bSum > 0 ? (rSum / bSum) : 1;          // >1.15 warm, <0.9 cool
    const subjectMean = subN ? subSum / subN : null, bgMean = bgN ? bgSum / bgN : null;
    const backlit = subjectMean != null && bgMean != null && subjectMean < 0.42 && bgMean / Math.max(0.02, subjectMean) > C.backlitRatio;
    const noiseLevel = noiseN ? noise / noiseN : 0;
    const isDark = mean < C.darkMean, isBright = mean > C.brightMean, isNight = mean < 0.14;

    // Score: exposure (mean in a good band), clipping, contrast, backlight.
    const exposure = mean < 0.3 ? clamp01((mean - 0.08) / 0.22) : mean > 0.7 ? clamp01((0.92 - mean) / 0.22) : 1;
    const clip = clamp01(1 - Math.max(highlights / C.clipHighlight, shadows / C.clipShadow) * 0.5);
    const con = contrast < C.lowContrast ? clamp01(contrast / C.lowContrast) : 1;
    const subjectExp = subjectMean == null ? 1 : subjectMean < 0.25 ? clamp01((subjectMean - 0.05) / 0.2) : 1;
    let score = exposure * 0.4 + clip * 0.2 + con * 0.15 + subjectExp * 0.25;
    if (backlit) score *= 0.7;
    score = Math.round(clamp01(score) * 100);

    let advice = 'Good light', tone = 'good', code = 'LIGHT_GOOD';
    if (backlit) { advice = 'Subject is backlit'; tone = 'warn'; code = 'BACKLIT'; }
    else if (isNight) { advice = 'Very dark — hold still'; tone = 'warn'; code = 'TOO_DARK'; }
    else if (isDark) { advice = 'Too dark — move toward the light'; tone = 'warn'; code = 'TOO_DARK'; }
    else if (isBright || highlights > C.clipHighlight) { advice = 'Too bright — highlights clipping'; tone = 'warn'; code = 'TOO_BRIGHT'; }
    else if (subjectMean != null && subjectMean < 0.25) { advice = 'Turn toward the light'; tone = 'warn'; code = 'SUBJECT_DARK'; }
    else if (contrast < C.lowContrast) { advice = 'Flat light'; tone = 'neutral'; code = 'FLAT'; }
    else if (isDark === false && motionStability < 0.4 && mean < 0.35) { advice = 'Hold still'; tone = 'warn'; code = 'HOLD_STILL'; }
    else if (score >= 85) { advice = 'Great lighting'; tone = 'good'; code = 'LIGHT_GREAT'; }

    this.last = { score, mean, contrast, highlights, shadows, saturation, warmth, subjectMean, bgMean, backlit, noise: noiseLevel, isDark, isBright, isNight, advice, tone, code };
    return this.last;
  }
}
