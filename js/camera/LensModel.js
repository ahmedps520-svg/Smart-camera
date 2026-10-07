import { ZOOM } from '../config/defaults.js';

/**
 * Describes what the current device can do optically, built from the camera
 * device list and the active track's capabilities.
 *
 * Browsers do not expose focal lengths, so physical lenses are inferred from
 * device labels (iOS: "Back Ultra Wide Camera", "Back Telephoto Camera", …) and
 * from the hardware zoom range the active track reports. Anything beyond the
 * hardware range is digital (a crop of the main sensor) and is labelled as such.
 */
export class LensModel {
  constructor() {
    this.devices = [];            // MediaDeviceInfo[] for the current facing
    this.hardware = null;         // {min, max, step} from track capabilities, or null
    this.hasUltraWide = false;
    this.hasTelephoto = false;
    this.facing = 'environment';
  }

  update({ devices, facing, capabilities }) {
    this.facing = facing;
    this.devices = devices.filter((d) => LensModel.facingOf(d) === facing);
    const labels = this.devices.map((d) => (d.label || '').toLowerCase());
    this.hasUltraWide = labels.some((l) => l.includes('ultra') || l.includes('wide angle') || l.includes('0.5'));
    this.hasTelephoto = labels.some((l) => l.includes('tele') || l.includes('zoom'));
    const z = capabilities?.zoom;
    this.hardware = z && typeof z.max === 'number' ? { min: z.min ?? 1, max: z.max, step: z.step ?? 0.1 } : null;
  }

  static facingOf(device) {
    const l = (device.label || '').toLowerCase();
    if (l.includes('front') || l.includes('user') || l.includes('facetime')) return 'user';
    return 'environment';
  }

  /** Lowest zoom factor achievable (0.5 if an ultra-wide is available). */
  get minZoom() {
    if (this.hardware && this.hardware.min < 1) return this.hardware.min;
    return this.hasUltraWide ? 0.5 : 1;
  }

  get maxZoom() { return Math.max(this.hardware?.max ?? 1, ZOOM.maxDigital); }

  /**
   * Zoom presets the device genuinely supports. Each has {factor, optical}.
   * - 0.5× only with an ultra-wide camera (or a hardware zoom range below 1).
   * - 2×/3×/5× when the hardware zoom range reaches them (optical if a telephoto exists).
   * - Without a hardware zoom API, 2× and 3× are offered as clearly-labelled digital crops.
   */
  presets() {
    const out = [];
    for (const f of ZOOM.presets) {
      if (f < 1) { if (this.minZoom <= f) out.push({ factor: f, optical: true }); continue; }
      if (f === 1) { out.push({ factor: 1, optical: true }); continue; }
      // Pro iPhones: .5 / 1 / 2 / 5 (3× is only offered when there is no 5× reach).
      if (this.hardware) { if (this.hardware.max >= f && !(f === 3 && this.hardware.max >= 5)) out.push({ factor: f, optical: this.hasTelephoto && f >= 2 }); }
      else if (f <= 3) out.push({ factor: f, optical: false });
    }
    return this.facing === 'user' ? out.filter((p) => p.factor <= 2) : out;
  }

  /** Nearest preset at or above the requested factor, preferring optical. */
  nearestPreset(factor) {
    const ps = this.presets();
    if (!ps.length) return { factor: 1, optical: true };
    let best = ps[0];
    for (const p of ps) if (Math.abs(p.factor - factor) < Math.abs(best.factor - factor)) best = p;
    return best;
  }

  describe() {
    const hw = this.hardware ? `hardware zoom ${this.hardware.min}–${this.hardware.max}×` : 'no hardware zoom API (digital zoom)';
    return `${this.devices.length} ${this.facing === 'user' ? 'front' : 'rear'} camera(s), ${hw}${this.hasUltraWide ? ', ultra wide' : ''}${this.hasTelephoto ? ', telephoto' : ''}`;
  }
}
