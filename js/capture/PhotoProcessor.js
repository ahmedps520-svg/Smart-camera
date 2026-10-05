import { LightingAnalyzer } from '../analysis/LightingAnalyzer.js';
import { FilterRecommender } from '../analysis/FilterRecommender.js';
import { renderStill } from '../render/LookRenderer.js';

/**
 * Post-capture, full-resolution analysis. Runs once per photo (never on the
 * live stream) and produces a thumbnail (with the chosen look) plus a quality
 * summary stored with the photo. The original bytes are kept untouched.
 */
export class PhotoProcessor {
  constructor() { this.lighting = new LightingAnalyzer(); this.filters = new FilterRecommender(); }

  async process({ blob, width, height, canvas }, context = {}) {
    const source = canvas || (await createImageBitmap(blob));
    const thumbCanvas = renderStill(source, { lookId: context.look || 'natural', strength: context.strength ?? 1, depth: context.depth || null, maxSide: 360 });
    const thumb = await new Promise((r) => thumbCanvas.toBlob(r, 'image/jpeg', 0.82));
    // Quality analysis on a 512 px sample (full-res statistics would not change the verdict).
    const aw = 512, ah = Math.max(1, Math.round((height / width) * 512));
    const ac = document.createElement('canvas'); ac.width = aw; ac.height = ah;
    const actx = ac.getContext('2d', { willReadFrequently: true, alpha: false }); actx.drawImage(source, 0, 0, aw, ah);
    const img = actx.getImageData(0, 0, aw, ah);
    const lighting = this.lighting.analyze(img, context.subject ? { box: context.subject.box } : null, 1);
    const filter = this.filters.recommend({ lighting, scene: context.scene });
    if (!canvas && source.close) source.close();
    return { thumb, lighting, filter };
  }
}
