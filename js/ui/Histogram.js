/**
 * Live luminance histogram, computed from a tiny copy of the visible frame
 * (independent of the AI pipeline, so it also works in plain Photo mode).
 * Clipped shadows/highlights are tinted red.
 */
export function luminanceHistogram(img, bins = 64) {
  const h = new Uint32Array(bins); const d = img.data;
  for (let i = 0; i < d.length; i += 4) h[Math.min(bins - 1, ((0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 256 * bins) | 0)]++;
  return h;
}

export class HistogramView {
  constructor(canvas) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.sample = document.createElement('canvas'); this.sample.width = 64; this.sample.height = 64;
    this.sctx = this.sample.getContext('2d', { willReadFrequently: true });
    this.frame = 0;
  }

  /** Update from the video (visible crop) every few frames. */
  update(video, crop) {
    if (++this.frame % 5) return;
    const vw = video.videoWidth, vh = video.videoHeight; if (!vw) return;
    this.sctx.drawImage(video, crop.x * vw, crop.y * vh, crop.w * vw, crop.h * vh, 0, 0, 64, 64);
    this.draw(luminanceHistogram(this.sctx.getImageData(0, 0, 64, 64)));
  }

  draw(hist) {
    const { ctx, canvas } = this; const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const max = Math.max(1, ...Array.from(hist).slice(1, -1));
    const bw = W / hist.length;
    for (let i = 0; i < hist.length; i++) {
      const h = Math.min(1, hist[i] / max) * (H - 8);
      const clipped = (i === 0 || i === hist.length - 1) && hist[i] > max * 0.15;
      ctx.fillStyle = clipped ? 'rgba(255,90,80,0.95)' : 'rgba(255,255,255,0.8)';
      ctx.fillRect(i * bw, H - 4 - h, Math.max(1, bw - 1), h);
    }
  }
}
