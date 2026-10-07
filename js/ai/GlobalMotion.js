/**
 * Camera-motion estimate between consecutive frames: how far the whole scene
 * shifted (in view units). Used to keep the AI's yellow box glued to the same
 * spot in the scene while the phone moves. Block matching (SAD) of a large
 * central region on a small greyscale copy — robust because it uses most of
 * the frame, not one subject.
 */
export class GlobalMotion {
  constructor({ width = 96, range = 0.16 } = {}) { this.W = width; this.range = range; this.prev = null; }

  reset() { this.prev = null; }

  /** Box-average downscale of a {data, w, h} grey image to W pixels wide. */
  small(gray) {
    const W = this.W, H = Math.max(8, Math.round(gray.h * (W / gray.w)));
    const out = new Float32Array(W * H), sx = gray.w / W, sy = gray.h / H;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let s = 0, n = 0;
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx)), y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { s += gray.data[yy * gray.w + xx]; n++; }
      out[y * W + x] = s / n;
    }
    return { data: out, w: W, h: H };
  }

  sad(a, b, ox, oy, m) {
    const { w, h } = a; let s = 0, n = 0;
    for (let y = m; y < h - m; y += 2) {
      const yy = y + oy; if (yy < 0 || yy >= h) continue;
      for (let x = m; x < w - m; x += 2) {
        const xx = x + ox; if (xx < 0 || xx >= w) continue;
        s += Math.abs(a.data[y * w + x] - b.data[yy * w + xx]); n++;
      }
    }
    return n ? s / n : Infinity;
  }

  /**
   * @param gray {data, w, h} current frame
   * @returns {{dx, dy, ok}} scene shift since the previous frame (view units; +x = content moved right)
   */
  push(gray) {
    const cur = this.small(gray);
    const prev = this.prev; this.prev = cur;
    if (!prev || prev.w !== cur.w || prev.h !== cur.h) return { dx: 0, dy: 0, ok: false };
    const R = Math.max(3, Math.round(cur.w * this.range)), m = R;
    let best = Infinity, bx = 0, by = 0;
    for (let oy = -R; oy <= R; oy += 2) for (let ox = -R; ox <= R; ox += 2) {
      const v = this.sad(prev, cur, ox, oy, m); if (v < best) { best = v; bx = ox; by = oy; }
    }
    const cx = bx, cy = by;
    for (let oy = cy - 1; oy <= cy + 1; oy++) for (let ox = cx - 1; ox <= cx + 1; ox++) {
      const v = this.sad(prev, cur, ox, oy, m); if (v < best) { best = v; bx = ox; by = oy; }
    }
    return { dx: bx / cur.w, dy: by / cur.h, ok: best < 40 };
  }
}
