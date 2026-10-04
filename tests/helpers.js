/** Shared fixtures: synthetic pose landmarks and image data for Node tests. */
export function makePose({ cx = 0.5, headY = 0.2, height = 0.7, facing = 0, vis = 0.95, armsUp = false, moveWristToFace = false } = {}) {
  const l = Array.from({ length: 33 }, () => ({ x: cx, y: headY, z: 0, visibility: vis }));
  const u = height / 7.5; // head unit
  const set = (i, x, y, v = vis) => { l[i] = { x, y, z: 0, visibility: v }; };
  const earW = 0.14 * u * 7.5 * 0.5;
  set(0, cx + facing * 2 * earW, headY + u * 0.5);      // nose (facing = offset / ear distance)
  set(1, cx - 0.02, headY + u * 0.4); set(2, cx - 0.03, headY + u * 0.4); set(3, cx - 0.04, headY + u * 0.4);
  set(4, cx + 0.02, headY + u * 0.4); set(5, cx + 0.03, headY + u * 0.4); set(6, cx + 0.04, headY + u * 0.4);
  set(7, cx - earW, headY + u * 0.5); set(8, cx + earW, headY + u * 0.5);
  set(9, cx - 0.015, headY + u * 0.75); set(10, cx + 0.015, headY + u * 0.75);
  const shY = headY + u * 1.4, shW = 0.12 * (height / 0.7);
  set(11, cx - shW, shY); set(12, cx + shW, shY);
  set(13, cx - shW * 1.2, armsUp ? shY - u : shY + u * 1.4); set(14, cx + shW * 1.2, armsUp ? shY - u : shY + u * 1.4);
  const wy = armsUp ? shY - u * 2 : shY + u * 2.6;
  set(15, moveWristToFace ? cx : cx - shW * 1.25, moveWristToFace ? headY + u * 0.5 : wy);
  set(16, cx + shW * 1.25, wy);
  for (const i of [17, 19, 21]) set(i, l[15].x, l[15].y + 0.01); for (const i of [18, 20, 22]) set(i, l[16].x, l[16].y + 0.01);
  const hipY = shY + u * 2.6, hipW = shW * 0.8;
  set(23, cx - hipW, hipY); set(24, cx + hipW, hipY);
  set(25, cx - hipW, hipY + u * 2); set(26, cx + hipW, hipY + u * 2);
  const ankleY = headY + height;
  set(27, cx - hipW, ankleY); set(28, cx + hipW, ankleY);
  for (const i of [29, 31]) set(i, l[27].x, l[27].y + 0.01); for (const i of [30, 32]) set(i, l[28].x, l[28].y + 0.01);
  return { landmarks: l, world: null };
}

export function makeImage(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = fn(x / w, y / h); const i = (y * w + x) * 4; data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255; }
  return { data, width: w, height: h };
}
