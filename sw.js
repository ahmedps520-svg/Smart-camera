/* Smart Camera service worker.
 * Precaches the app shell, the on-device vision runtime and all model files so
 * the full experience works offline (airplane mode) after the first visit.
 * No network requests are made for analysis at any time; the only fetches are
 * for the app's own static files.
 */
const VERSION = 'smart-camera-v1.2.0';
const SHELL_CACHE = `${VERSION}-shell`;
// Models only change when this name changes, so app updates never re-download ~25 MB.
const MODEL_CACHE = 'smart-camera-models-v1';
const KEEP = [SHELL_CACHE, MODEL_CACHE];

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/main.js',
  './js/config/defaults.js',
  './js/util/math.js',
  './js/util/smoothing.js',
  './js/util/events.js',
  './js/settings/Settings.js',
  './js/camera/CameraController.js',
  './js/camera/LensModel.js',
  './js/motion/MotionSensor.js',
  './js/vision/VisionEngine.js',
  './js/vision/MediaPipeBackend.js',
  './js/vision/FrameSampler.js',
  './js/vision/PerformanceGovernor.js',
  './js/vision/ViewTransform.js',
  './js/render/LookRenderer.js',
  './js/analysis/SubjectTracker.js',
  './js/analysis/PoseScorer.js',
  './js/analysis/CompositionEngine.js',
  './js/analysis/LightingAnalyzer.js',
  './js/analysis/ZoomAdvisor.js',
  './js/analysis/SceneClassifier.js',
  './js/analysis/FilterRecommender.js',
  './js/analysis/GroupAnalyzer.js',
  './js/reasoning/PhotographyReasoner.js',
  './js/reasoning/RecommendationValidator.js',
  './js/reasoning/Debouncer.js',
  './js/capture/AutoCaptureController.js',
  './js/capture/PhotoProcessor.js',
  './js/library/PhotoLibrary.js',
  './js/ui/Overlay.js',
  './js/ui/Controls.js',
  './js/ui/ReviewView.js',
  './js/ui/LibraryView.js',
  './js/ui/Haptics.js',
  './js/ui/Toast.js',
  './js/ui/Sounds.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon.ico',
];

const MODELS = [
  './vendor/mediapipe/tasks-vision/vision_bundle.mjs',
  './vendor/mediapipe/tasks-vision/wasm/vision_wasm_internal.js',
  './vendor/mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm',
  './models/pose_landmarker_lite.task',
  './models/blaze_face_short_range.tflite',
  './models/efficientdet_lite0.tflite',
  './models/efficientnet_lite0.tflite',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await shell.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })));
    const models = await caches.open(MODEL_CACHE);
    // Add models one by one so a single failure does not abort the whole install.
    await Promise.all(MODELS.map(async (url) => {
      try { await models.add(url); } catch (e) { /* retried lazily on first use */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

function isModel(url) {
  return url.pathname.includes('/models/') || url.pathname.includes('/vendor/');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never proxy third-party requests

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(SHELL_CACHE);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        return (await caches.match('./index.html')) || (await caches.match('./'));
      }
    })());
    return;
  }

  // Models and runtime: cache-first, immutable within a version.
  if (isModel(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(MODEL_CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  // App shell: network first (so updates show up immediately), cache when offline.
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      return (await cache.match(req, { ignoreSearch: true })) || new Response('Offline', { status: 503 });
    }
  })());
});
