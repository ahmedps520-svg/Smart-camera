/**
 * Draws the live video into a small canvas for cheap CPU-side analysis
 * (lighting, histogram, noise). The vision models read the <video> directly on
 * the GPU; this sampler only serves the pixel-statistics stage.
 */
export class FrameSampler {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true, alpha: false });
    this.width = 0; this.height = 0;
  }

  /** Returns ImageData (reused buffer) at the requested analysis width. */
  sample(video, targetWidth) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const w = targetWidth, h = Math.max(1, Math.round((vh / vw) * targetWidth));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.width = w; this.height = h;
    this.ctx.drawImage(video, 0, 0, w, h);
    return this.ctx.getImageData(0, 0, w, h);
  }
}
