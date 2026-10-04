import { FILTERS } from '../config/defaults.js';

/**
 * Suggests a look based purely on local image characteristics and the scene.
 * The original capture is never modified; filters apply to previews/exports only.
 * @returns {{id:string, name:string, reason:string, ranked:string[]}}
 */
export class FilterRecommender {
  recommend({ lighting, scene }) {
    const picks = [];
    const add = (id, weight, reason) => picks.push({ id, weight, reason });
    if (!lighting) return { id: 'natural', name: 'Natural', reason: 'Default', ranked: ['natural'] };
    const { warmth, saturation, mean, contrast, isNight, isDark } = lighting;
    if (isNight || (isDark && scene === 'night')) add('night', 3, 'Low light');
    if (scene === 'sunset' || (warmth > 1.3 && mean < 0.55)) add('golden', 2.6, 'Warm, low sun');
    if (scene === 'portrait') { add(saturation < 0.25 ? 'warm' : 'soft', 2.2, 'Flattering for skin'); add('natural', 2.0, 'Keep it true'); }
    if (scene === 'group') add('natural', 2.3, 'True colours for everyone');
    if (scene === 'landscape' || scene === 'beach') add(saturation < 0.3 ? 'vibrant' : 'natural', 2.2, 'Bring out the scenery');
    if (scene === 'architecture') add(saturation < 0.2 ? 'bw' : 'contrast', 2.2, 'Emphasise structure');
    if (scene === 'street') add(contrast > 0.22 ? 'bw' : 'cinematic', 2.1, 'Street mood');
    if (scene === 'food') add('warm', 2.2, 'Appetising warmth');
    if (scene === 'product') add('contrast', 1.9, 'Crisp detail');
    if (scene === 'pet') add('vibrant', 1.8, 'Lively fur and eyes');
    if (scene === 'vehicle') add('cinematic', 2.0, 'Dramatic look');
    if (warmth < 0.92) add('warm', 1.6, 'Counter a cool cast');
    if (warmth > 1.45 && scene !== 'sunset') add('cool', 1.4, 'Counter a warm cast');
    if (saturation < 0.12 && !isNight) add('bw', 1.7, 'Scene is nearly monochrome');
    if (contrast < 0.12) add('contrast', 1.5, 'Flat light');
    add('natural', 1.0, 'Default');
    const agg = {};
    for (const p of picks) agg[p.id] = { weight: (agg[p.id]?.weight || 0) + p.weight, reason: agg[p.id]?.reason || p.reason };
    const ranked = Object.entries(agg).sort((a, b) => b[1].weight - a[1].weight);
    const [id, info] = ranked[0];
    const f = FILTERS.find((x) => x.id === id) || FILTERS[0];
    return { id: f.id, name: f.name, reason: info.reason, ranked: ranked.map(([k]) => k) };
  }
}
