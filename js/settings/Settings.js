import { DEFAULT_SETTINGS } from '../config/defaults.js';
import { Emitter } from '../util/events.js';

// v3: new camera layout (3:4 viewfinder, grid on, ✦ Find the shot as the default mode).
const KEY = 'smart-camera.settings.v3';

/** Persistent user settings (localStorage). Emits 'change' with {key, value}. */
export class Settings extends Emitter {
  constructor() {
    super();
    this.data = { ...DEFAULT_SETTINGS };
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
      Object.assign(this.data, saved);
    } catch { /* ignore corrupt storage */ }
    const params = new URLSearchParams(location.search);
    const mode = params.get('mode');
    if (['pose', 'photo', 'smart', 'portrait'].includes(mode)) this.data.mode = mode;
    if (this.data.grid === true) this.data.grid = 'thirds'; else if (this.data.grid === false) this.data.grid = 'off';
  }
  get(k) { return this.data[k]; }
  set(k, v) {
    if (this.data[k] === v) return;
    this.data[k] = v;
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch { /* quota or private mode */ }
    this.emit('change', { key: k, value: v });
  }
  all() { return { ...this.data }; }
}
