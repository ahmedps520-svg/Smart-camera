/**
 * Candidate subjects for "Find the shot", all in view coordinates:
 * people (pose tracker), objects (on-device detector) and the most striking
 * light in the frame (a simple saliency map). Each candidate gets a short,
 * human label ("distant boat", "sunset glow") and an interest score 0…1.
 */
const ANIMALS = new Set(['bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe']);
const VEHICLES = new Set(['boat', 'car', 'airplane', 'bicycle', 'motorcycle', 'bus', 'train', 'truck']);
const FOOD = new Set(['pizza', 'donut', 'cake', 'sandwich', 'hot dog', 'banana', 'apple', 'orange', 'broccoli', 'carrot', 'bowl', 'cup', 'wine glass']);
const NAMES = { 'cell phone': 'phone', 'dining table': 'table', 'potted plant': 'plant', 'sports ball': 'ball', 'teddy bear': 'teddy bear', airplane: 'plane', motorcycle: 'motorbike' };

export function kindOf(label) {
  if (label === 'person') return 'person';
  if (ANIMALS.has(label)) return 'animal';
  if (VEHICLES.has(label)) return 'vehicle';
  if (FOOD.has(label)) return 'food';
  return 'object';
}

const TYPE_WEIGHT = { person: 1, animal: 0.95, vehicle: 0.85, food: 0.8, object: 0.6, light: 0.55, group: 1 };

/** "distant boat", "dog", "cup up close" … */
export function describe(label, box) {
  const name = NAMES[label] || label;
  const area = box.w * box.h;
  if (area < 0.012) return `distant ${name}`;
  if (area > 0.3) return `${name} up close`;
  return name;
}

const edgeCut = (b) => b.x < 0.01 || b.y < 0.01 || b.x + b.w > 0.99 || b.y + b.h > 0.99;
const clampBox = (b) => { const x = Math.max(0, b.x), y = Math.max(0, b.y); return { x, y, w: Math.min(1, b.x + b.w) - x, h: Math.min(1, b.y + b.h) - y }; };

export function objectCandidates(objects = []) {
  return objects.filter((o) => o.score >= 0.35 && o.box.w > 0 && o.box.h > 0).map((o) => {
    const box = clampBox(o.box), area = box.w * box.h, kind = kindOf(o.label);
    const size = area < 0.0006 ? 0.6 : area > 0.6 ? 0.7 : area >= 0.01 && area <= 0.3 ? 1.1 : 1;
    const score = Math.min(1, TYPE_WEIGHT[kind] * o.score * size * (edgeCut(box) ? 0.8 : 1));
    return { key: `obj:${o.label}`, label: describe(o.label, box), kind, box, score };
  });
}

export function peopleCandidates(tracked, { selfie = false } = {}) {
  if (!tracked?.subjects?.length) return [];
  if (tracked.count > 1 && tracked.groupBox) {
    return [{ key: 'group', label: `group of ${tracked.count}`, kind: 'group', box: clampBox(tracked.groupBox), score: 0.95 }];
  }
  return tracked.subjects.filter((s) => !s.coasting).map((s) => {
    const box = clampBox(s.box);
    return { key: 'person', label: selfie ? 'you' : describe('person', box), kind: 'person', box, head: s.head ? { x: s.head.x, y: s.head.y } : null, score: Math.min(1, 0.75 + Math.min(0.25, box.h)) };
  });
}

/**
 * Most striking region: bright, saturated, warm, contrasty cells on an 8×12 grid.
 * Labelled from the colour of the light ("sunset glow", "the light", "point of interest").
 */
export function saliencyCandidate(img, { scene = 'outdoor' } = {}) {
  if (!img) return null;
  const { data, width: w, height: h } = img;
  const GX = 8, GY = 12, cw = w / GX, ch = h / GY;
  const cells = [];
  let globalL = 0, n = 0;
  for (let gy = 0; gy < GY; gy++) for (let gx = 0; gx < GX; gx++) {
    let L = 0, S = 0, warm = 0, L2 = 0, k = 0;
    for (let y = Math.floor(gy * ch); y < Math.floor((gy + 1) * ch); y += 2) for (let x = Math.floor(gx * cw); x < Math.floor((gx + 1) * cw); x += 2) {
      const i = (y * w + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
      const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      L += l; L2 += l * l; S += mx ? (mx - mn) / mx : 0; warm += (r - b) / 255; k++;
    }
    if (!k) continue;
    L /= k; S /= k; warm /= k; const con = Math.sqrt(Math.max(0, L2 / k - L * L));
    cells.push({ gx, gy, L, S, warm, con }); globalL += L; n++;
  }
  if (!cells.length) return null;
  globalL /= n;
  let best = null;
  for (const c of cells) {
    const edge = c.gx === 0 || c.gx === GX - 1 || c.gy === 0 || c.gy === GY - 1 ? 0.85 : 1;
    c.s = ((c.L - globalL) * 1.2 + c.S * 0.6 + Math.max(0, c.warm) * 0.8 + c.con * 1.5) * edge;
    if (!best || c.s > best.s) best = c;
  }
  if (best.s < 0.12) return null;
  // Sub-cell peak: weighted centre of the best cell and its neighbours, so the
  // position is smooth (a sun between two cells must not snap to either side).
  let sx = 0, sy = 0, sw = 0;
  const floor = best.s * 0.5;
  for (const c of cells) {
    if (Math.abs(c.gx - best.gx) > 1 || Math.abs(c.gy - best.gy) > 1) continue;
    const wgt = Math.max(0, c.s - floor); sx += (c.gx + 0.5) * wgt; sy += (c.gy + 0.5) * wgt; sw += wgt;
  }
  const px = sw ? sx / sw / GX : (best.gx + 0.5) / GX, py = sw ? sy / sw / GY : (best.gy + 0.5) / GY;
  const box = clampBox({ x: px - 0.75 / GX, y: py - 0.75 / GY, w: 1.5 / GX, h: 1.5 / GY });
  const label = (scene === 'sunset' || (best.warm > 0.18 && best.L > 0.35)) ? 'sunset glow' : best.L > 0.8 ? 'the light' : 'point of interest';
  return { key: `light:${label}`, label, kind: 'light', box, score: Math.min(1, TYPE_WEIGHT.light * Math.min(1, best.s / 0.6)) };
}
