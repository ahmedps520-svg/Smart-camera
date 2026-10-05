/**
 * Moves detections from raw video-frame coordinates into view coordinates
 * (0..1 across what the viewfinder actually shows). All composition, scoring
 * and overlay maths then works on exactly what the user sees. Landmarks that
 * fall outside the view are marked as not visible.
 */
const inView = (x, y, m = 0) => x >= -m && x <= 1 + m && y >= -m && y <= 1 + m;

export function toViewPoint(p, c) { return { x: (p.x - c.x) / c.w, y: (p.y - c.y) / c.h }; }

export function toViewBox(b, c) { return { x: (b.x - c.x) / c.w, y: (b.y - c.y) / c.h, w: b.w / c.w, h: b.h / c.h }; }

export function transformAnalysis({ people = [], faces = [], objects = [] }, crop) {
  const full = !crop || (crop.x === 0 && crop.y === 0 && crop.w === 1 && crop.h === 1);
  if (full) return { people, faces, objects };
  const outPeople = people.map((p) => ({
    world: p.world,
    landmarks: p.landmarks.map((l) => {
      const v = toViewPoint(l, crop);
      const visible = inView(v.x, v.y, 0.005);
      return { ...l, x: v.x, y: v.y, visibility: visible ? (l.visibility ?? 1) : Math.min(l.visibility ?? 1, 0.15) };
    }),
  }));
  const keepBox = (b) => { const cx = b.x + b.w / 2, cy = b.y + b.h / 2; return inView(cx, cy); };
  const outFaces = faces.map((f) => ({ ...f, box: toViewBox(f.box, crop), keypoints: (f.keypoints || []).map((k) => toViewPoint(k, crop)) })).filter((f) => keepBox(f.box));
  const outObjects = objects.map((o) => ({ ...o, box: toViewBox(o.box, crop) })).filter((o) => keepBox(o.box));
  return { people: outPeople, faces: outFaces, objects: outObjects };
}
