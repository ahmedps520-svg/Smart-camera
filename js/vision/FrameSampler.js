/**
 * Draws the visible part of the live video into a small canvas for cheap
 * CPU-side analysis (lighting, histogram, horizon, clutter). The vision models
 * read the <video> directly on the GPU; this sampler only serves pixel statistics.
 */
export class FrameSampler {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true, alpha: false });
    this.width = 0; this.height = 0;
  }

  /**
   * Returns ImageData (reused buffer) whose long side is about `targetSize` pixels.
   * @param crop normalised visible rect of the video frame
   */
  sample(video, targetSize, crop = { x: 0, y: 0, w: 1, h: 1 }) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const sx = crop.x * vw, sy = crop.y * vh, sw = crop.w * vw, sh = crop.h * vh;
    const longSide = Math.round(targetSize * 1.33);
    const scale = longSide / Math.max(sw, sh);
    const w = Math.max(8, Math.round(sw * scale)), h = Math.max(8, Math.round(sh * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.width = w; this.height = h;
    this.ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
    return this.ctx.getImageData(0, 0, w, h);
  }
}
