import { DEFAULT_SETTINGS } from '../config/defaults.js';
import { Emitter } from '../util/events.js';

const KEY = 'smart-camera.settings.v1';

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
    if (mode === 'pose' || mode === 'photo' || mode === 'smart') this.data.mode = mode;
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
