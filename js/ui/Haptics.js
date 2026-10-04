/** Haptics via the Vibration API where available (Android/Chrome). iOS Safari has no web haptics; sound and animation stand in. */
export const Haptics = {
  enabled: true,
  tap() { if (this.enabled && navigator.vibrate) navigator.vibrate(10); },
  success() { if (this.enabled && navigator.vibrate) navigator.vibrate([12, 40, 18]); },
  warn() { if (this.enabled && navigator.vibrate) navigator.vibrate([30]); },
  shutter() { if (this.enabled && navigator.vibrate) navigator.vibrate([8, 20, 25]); },
};
