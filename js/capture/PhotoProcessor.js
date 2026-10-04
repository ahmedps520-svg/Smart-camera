import { LightingAnalyzer } from '../analysis/LightingAnalyzer.js';
import { FilterRecommender } from '../analysis/FilterRecommender.js';

/**
 * Post-capture, full-resolution analysis. Runs only once per photo (never on the
 * live stream) and produces a thumbnail plus a quality summary stored with the
 * photo. Keeps the original bytes untouched.
 */
export class PhotoProcessor {
  constructor() { this.lighting = new LightingAnalyzer(); this.filters = new FilterRecommender(); }

  async process({ blob, width, height, canvas }, context = {}) {
    const bitmap = canvas || (await createImageBitmap(blob));
    // Thumbnail.
    const tw = 320, th = Math.round((height / width) * 320);
    const tc = document.createElement('canvas'); tc.width = tw; tc.height = th;
    const tctx = tc.getContext('2d', { alpha: false }); tctx.drawImage(bitmap, 0, 0, tw, th);
    const thumb = await new Promise((r) => tc.toBlob(r, 'image/jpeg', 0.8));
    // Quality analysis on a 512 px sample (full-res statistics would not change the verdict).
    const aw = 512, ah = Math.round((height / width) * 512);
    const ac = document.createElement('canvas'); ac.width = aw; ac.height = ah;
    const actx = ac.getContext('2d', { willReadFrequently: true, alpha: false }); actx.drawImage(bitmap, 0, 0, aw, ah);
    const img = actx.getImageData(0, 0, aw, ah);
    const lighting = this.lighting.analyze(img, context.subject ? { box: context.subject.box } : null, 1);
    const filter = this.filters.recommend({ lighting, scene: context.scene });
    if (!canvas && bitmap.close) bitmap.close();
    return { thumb, lighting, filter };
  }
}
