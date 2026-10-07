/**
 * Central, overridable configuration for Smart Camera.
 * Nothing in the analysis layers hardcodes thresholds: every weight, target and
 * timing lives here and can be overridden at runtime via Settings.
 */
export const MODELS = {
  // Swap any entry to use a different on-device model. Paths are relative to the app root.
  pose: { path: 'models/pose_landmarker_lite.task', numPoses: 4, minDetection: 0.4, minTracking: 0.4, minPresence: 0.4 },
  face: { path: 'models/blaze_face_short_range.tflite', minDetection: 0.45 },
  // int8 models run on the CPU (XNNPACK) delegate: they are small, run rarely and the GPU delegate rejects int8 output tensors.
  objects: { path: 'models/efficientdet_lite0.tflite', maxResults: 6, scoreThreshold: 0.45, delegate: 'CPU' },
  scene: { path: 'models/efficientnet_lite0.tflite', maxResults: 5, scoreThreshold: 0.1, delegate: 'CPU' },
  // Person segmentation for Portrait mode (background blur). Loaded on first use.
  segmenter: { path: 'models/selfie_segmenter.tflite' },
  // Face mesh + blendshapes for smile shutter and blink guard. Loaded on first use.
  faceMesh: { path: 'models/face_landmarker.task', numFaces: 4, minDetection: 0.4 },
  runtime: {
    wasmLoaderPath: 'vendor/mediapipe/tasks-vision/wasm/vision_wasm_internal.js',
    wasmBinaryPath: 'vendor/mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm',
    bundle: '../../vendor/mediapipe/tasks-vision/vision_bundle.mjs',
    delegate: 'GPU',   // default for models that do not specify one (pose, face)
  },
};

/** Scheduling (frames between runs) per analysis stage, by performance tier. */
export const SCHEDULE = {
  high:     { pose: 1, face: 2, lighting: 2, objects: 20, scene: 45, segment: 2, expressions: 3, maxFps: 30 },
  balanced: { pose: 2, face: 3, lighting: 3, objects: 30, scene: 60, segment: 2, expressions: 4, maxFps: 24 },
  low:      { pose: 3, face: 5, lighting: 4, objects: 60, scene: 120, segment: 3, expressions: 6, maxFps: 15 },
};

/** Performance governor: software thermal management (the web has no thermal API). */
export const GOVERNOR = {
  sampleWindow: 45,          // frames
  slowInferenceMs: 38,       // average pose inference above this → step down
  fastInferenceMs: 18,       // average below this (for a sustained period) → step up
  stepUpAfterMs: 20000,
  droppedFrameRatio: 0.35,   // ratio of frames the main thread couldn't keep up with
  analysisWidth: { high: 320, balanced: 256, low: 192 }, // CPU-side lighting analysis size
};

/** Pose quality scoring weights (0..1). Sum does not need to be 1; it is normalised. */
export const POSE_SCORING = {
  weights: {
    visibility: 1.0,     // key joints visible and confident
    headAngle: 0.9,      // head not excessively tilted / turned away
    faceVisible: 1.0,
    shoulders: 0.7,      // shoulders level and open
    arms: 0.6,           // arms not crossing the face/torso awkwardly
    legs: 0.4,           // for full-body shots, legs visible and not crossed
    symmetry: 0.5,
    stability: 0.9,      // landmark velocity low
  },
  targets: {
    maxHeadTiltDeg: 25,
    maxShoulderTiltDeg: 12,
    minFaceWidthRatio: 0.2,   // ear-to-ear vs shoulder width → face turned toward camera
    stillVelocity: 0.012,     // normalised px/frame considered perfectly still
    movingVelocity: 0.06,     // normalised px/frame considered clearly moving
  },
};

/** Composition engine targets. All coordinates are normalised (0..1). */
export const COMPOSITION = {
  thirds: [1 / 3, 2 / 3],
  edgeMargin: 0.04,
  headroom: { ideal: 0.08, min: 0.02, max: 0.18 },    // fraction of frame height above head
  subjectHeight: {                                        // ideal subject height fraction by shot type
    full: 0.82, threeQuarter: 0.7, half: 0.6, closeUp: 0.55, group: 0.65,
  },
  tolerances: { position: 0.05, size: 0.1, headroom: 0.03 },
  horizon: { preferredRows: [1 / 3, 2 / 3], tolerance: 0.06 },
  levelToleranceDeg: 2,
  hysteresisDeg: 1,
};

/** Overall score blend for Smart Pose. */
export const OVERALL = {
  weights: { pose: 0.35, framing: 0.3, lighting: 0.15, stability: 0.2 },
};

/**
 * Automatic capture gate (Smart Pose).
 * `overall` is the main threshold; the others are floors that stop a capture
 * when one aspect is clearly bad. Movement is measured in torso lengths so it
 * behaves the same for a selfie and a full-body shot.
 */
export const AUTO_CAPTURE = {
  thresholds: { overall: 76, pose: 62, framing: 50, stability: 60, lighting: 25 },
  holdMs: 800,           // conditions must hold this long before the countdown
  countdownMs: 800,      // "Perfect" countdown length
  graceMs: 400,          // brief dips below threshold shorter than this are ignored
  cooldownMs: 2500,      // after a capture before another auto capture may arm
  cancelMovement: 0.45,  // torso lengths of movement that cancels the hold/countdown
  requirePoseChange: 0.2,// torso lengths the pose must change before shooting again…
  repeatAfterMs: 8000,   // …or this long holding the same pose
  groupSettleMs: 600,    // extra hold when more than one person is in frame
  eyesOpenMin: 0.45,     // blink guard: lowest eyes-open score among faces to allow a shot
  blinkWaitMs: 900,      // at the end of the countdown, wait up to this long for eyes to open
};

/**
 * Smart Photo coaching: one small instruction at a time, held longer, with a wider
 * dead zone, and frozen while the phone is moving (the user is already responding).
 */
export const SMART_PHOTO = {
  enterRatio: 1.7,       // deviation must exceed tolerance × this to start an instruction…
  exitRatio: 0.5,        // …and fall below tolerance × this to clear it
  minHoldMs: 1600,
  confirmMs: 650,
  freezeBelowStability: 0.55,
  ring: '#FFD60A',
};

/** Guidance debouncing / hysteresis. */
export const GUIDANCE = {
  minHoldMs: 900,        // a message stays at least this long
  enterRatio: 1.0,       // deviation must exceed tolerance * enterRatio to show "MOVE"
  exitRatio: 0.6,        // ... and drop below tolerance * exitRatio to clear it
  smoothing: 0.35,       // EMA alpha for subject position/size
  boxSmoothing: 0.18,    // EMA alpha for the composition box
};

export const ZOOM = {
  presets: [0.5, 1, 2, 3, 5],
  maxDigital: 10,
  hysteresis: 0.18,      // relative difference required before a new zoom suggestion
  minSubjectHeightForZoom: 0.3, // below this → recommend zooming in / moving closer
};

export const LIGHTING = {
  darkMean: 0.22, brightMean: 0.8,
  clipHighlight: 0.06, clipShadow: 0.1,
  backlitRatio: 1.8,     // background/subject luminance ratio
  lowContrast: 0.12,
  noiseThreshold: 0.045,
};

/**
 * Looks. Each is a set of parameters for the colour pipeline in
 * render/LookRenderer.js (GPU shader for preview and export, with an identical
 * CPU path). `css` is only a fallback for browsers without WebGL.
 *
 * Parameters (defaults in LOOK_DEFAULTS): brightness, temperature (−1 cool … 1 warm),
 * tint (− green … + magenta), contrast, curve (S-curve amount), saturation,
 * fade (lifted blacks), lift (shadow boost), shadows / highlights (RGB split-tone
 * offsets), vignette, grain.
 */
export const LOOK_DEFAULTS = {
  brightness: 1, temperature: 0, tint: 0, contrast: 1, curve: 0, saturation: 1,
  fade: 0, lift: 0, shadows: [0, 0, 0], highlights: [0, 0, 0], vignette: 0, grain: 0,
};

export const FILTERS = [
  { id: 'natural', name: 'Original', params: {}, css: 'none' },
  // Film looks (shown first in the editor).
  { id: 'clean', name: 'Clean', params: { brightness: 1.06, contrast: 0.94, saturation: 0.9, temperature: -0.08, fade: 0.03, lift: 0.05, highlights: [0.01, 0.015, 0.025] }, css: 'brightness(1.07) contrast(0.94) saturate(0.9)' },
  { id: 'harbor', name: 'Harbor', params: { temperature: -0.32, tint: -0.04, saturation: 0.78, contrast: 1.1, curve: 0.28, shadows: [-0.03, 0.045, 0.085], highlights: [0.02, 0.03, 0.02], fade: 0.05, vignette: 0.28 }, css: 'saturate(0.8) contrast(1.12) hue-rotate(-10deg) brightness(0.98)' },
  { id: 'dusk', name: 'Dusk', params: { temperature: 0.35, tint: 0.1, saturation: 1.15, curve: 0.22, shadows: [0.06, -0.01, 0.085], highlights: [0.085, 0.03, -0.035], fade: 0.06, vignette: 0.32 }, css: 'sepia(0.3) saturate(1.3) hue-rotate(-12deg) contrast(1.05)' },
  { id: 'pop', name: 'Pop', params: { brightness: 1.08, contrast: 1.06, saturation: 1.38, temperature: 0.12, tint: 0.03, lift: 0.06, curve: 0.12, highlights: [0.02, 0.01, 0.0] }, css: 'brightness(1.08) saturate(1.4) contrast(1.06)' },
  { id: 'relic', name: 'Relic', params: { temperature: 0.25, saturation: 0.62, contrast: 0.9, fade: 0.14, grain: 0.07, vignette: 0.45, curve: 0.1, shadows: [0.04, 0.02, -0.02], highlights: [0.04, 0.02, -0.045] }, css: 'sepia(0.45) saturate(0.7) contrast(0.88) brightness(1.04)' },
  { id: 'warm', name: 'Warm', params: { temperature: 0.4, tint: 0.04, saturation: 1.2, contrast: 1.06, brightness: 1.03 }, css: 'sepia(0.35) saturate(1.4) brightness(1.04)' },
  { id: 'cool', name: 'Cool', params: { temperature: -0.45, tint: -0.02, saturation: 1.05, contrast: 1.08, highlights: [-0.02, 0.01, 0.05] }, css: 'saturate(1.1) hue-rotate(-12deg) brightness(1.03) contrast(1.08)' },
  { id: 'cinematic', name: 'Cinematic', params: { curve: 0.5, saturation: 0.75, temperature: 0.05, shadows: [-0.05, 0.05, 0.1], highlights: [0.1, 0.04, -0.06], fade: 0.05, vignette: 0.6 }, css: 'contrast(1.3) saturate(0.75) sepia(0.2)' },
  { id: 'vibrant', name: 'Vibrant', params: { saturation: 1.8, contrast: 1.12, curve: 0.2, brightness: 1.03 }, css: 'saturate(1.9) contrast(1.12)' },
  { id: 'bw', name: 'B&W', params: { saturation: 0, contrast: 1.22, curve: 0.4, grain: 0.05, vignette: 0.3 }, css: 'grayscale(1) contrast(1.3)' },
  { id: 'soft', name: 'Soft', params: { contrast: 0.8, fade: 0.12, saturation: 0.85, brightness: 1.07, temperature: 0.1, highlights: [0.03, 0.02, 0.03] }, css: 'contrast(0.82) brightness(1.1) saturate(0.85)' },
  { id: 'contrast', name: 'High Contrast', params: { contrast: 1.45, curve: 0.6, saturation: 1.2, vignette: 0.25 }, css: 'contrast(1.6) saturate(1.2)' },
  { id: 'golden', name: 'Golden Hour', params: { temperature: 0.6, tint: 0.05, saturation: 1.35, curve: 0.25, brightness: 1.05, highlights: [0.1, 0.05, -0.06], shadows: [0.04, 0, -0.04], vignette: 0.35 }, css: 'sepia(0.55) saturate(1.6) brightness(1.06) contrast(1.08)' },
  { id: 'night', name: 'Night', params: { brightness: 1.3, lift: 0.25, temperature: -0.22, saturation: 0.8, contrast: 1.1, curve: 0.15, grain: 0.03 }, css: 'brightness(1.4) contrast(1.1) saturate(0.8)' },
];

/**
 * AI styles for ✦ Find the shot. Each style changes what the AI looks for
 * (weights per subject kind), where it puts the subject (aim), how far it
 * zooms (zoomScale, continuous, maxZoom), how quickly it shoots, and the look
 * and frame the photo gets. Everything else in the pipeline is shared.
 */
export const AI_STYLES = [
  {
    id: 'standard', name: 'Standard', tagline: 'balanced framing',
    scanText: 'AI is finding the shot...', scanMs: 3000, minScanFrames: 5,
    weights: {}, aim: 'center', zoomScale: 1, continuous: false,
    readyHoldMs: 1300, minStability: 0.6, tolScale: 1, look: null, frame: null,
  },
  {
    id: 'daily', name: 'Daily', tagline: 'quick and natural',
    scanText: 'Quick shot...', scanMs: 1500, minScanFrames: 3,
    weights: { person: 1.1 }, aim: 'center', zoomScale: 0.85, maxZoom: 2, continuous: false,
    readyHoldMs: 600, minStability: 0.5, tolScale: 1.5, look: 'natural', frame: 'none',
  },
  {
    id: 'cinematic', name: 'Cinematic', tagline: 'tight, widescreen, moody',
    scanText: 'Finding a cinematic shot...', scanMs: 3200, minScanFrames: 5,
    weights: { person: 1.15, vehicle: 1.2, light: 1.15, object: 0.85 }, aim: 'thirds', zoomScale: 1.8, continuous: true,
    readyHoldMs: 1700, minStability: 0.7, tolScale: 0.9, look: 'cinematic', frame: 'cinema', letterbox: true, faceAim: 0.49, faceBand: [0.03, 0.04],
    readyText: 'Rolling — hold it steady.',
  },
  {
    id: 'snapchat', name: 'Snapchat', tagline: 'faces up close, full screen',
    scanText: 'Finding your snap...', scanMs: 1200, minScanFrames: 3,
    weights: { person: 1.6, group: 1.5, animal: 1.2, light: 0.6, object: 0.7 }, aim: 'center', faceAim: 0.36, faceBand: [0.14, 0.09], personFrac: 0.85,
    zoomScale: 1.15, continuous: true, maxZoom: 3, readyHoldMs: 550, minStability: 0.45, tolScale: 1.4,
    look: 'pop', frame: 'none', aspect: 'full', readyText: 'Looking good — hold it!',
  },
  {
    id: 'scenic', name: 'Scenic', tagline: 'wide views, level horizon',
    scanText: 'Finding the view...', scanMs: 3000, minScanFrames: 5,
    weights: { light: 1.7, person: 0.6, group: 0.6, object: 0.7 }, aim: 'center', lightAimY: 0.42, zoom: 'wide',
    readyHoldMs: 1400, minStability: 0.65, tolScale: 1.3, requireLevel: true, look: 'vibrant', frame: null,
  },
  {
    id: 'street', name: 'Street', tagline: 'the decisive moment',
    scanText: 'Finding the moment...', scanMs: 1500, minScanFrames: 3,
    weights: { person: 1.3, vehicle: 1.2, animal: 1.1, light: 0.7 }, aim: 'thirds', zoomScale: 1.1, maxZoom: 2, continuous: false,
    readyHoldMs: 450, minStability: 0.45, tolScale: 1.3, look: 'bw', frame: null,
  },
  {
    id: 'film', name: 'Film', tagline: 'vintage colour, date stamp',
    scanText: 'Finding a film moment...', scanMs: 2500, minScanFrames: 4,
    weights: { light: 1.1 }, aim: 'thirds', zoomScale: 1, continuous: false,
    readyHoldMs: 1200, minStability: 0.6, tolScale: 1.1, look: 'relic', frame: 'date',
  },
];

export const SCENES = [
  'portrait', 'group', 'landscape', 'architecture', 'food', 'pet', 'vehicle', 'sunset',
  'night', 'product', 'street', 'beach', 'indoor', 'outdoor',
];

export const DEFAULT_SETTINGS = {
  mode: 'photo',             // photo (✦ Find the shot) | smart | pose | portrait
  aiEnabled: true,
  grid: 'thirds',            // off | thirds | golden | center
  histogram: false,
  zebra: false,              // highlight-clipping stripes
  handTrigger: true,         // raise a hand → 3 s timer
  smileTrigger: false,       // smile → capture
  blinkGuard: true,          // never auto-capture closed eyes
  portraitBlur: 0.6,         // 0 (f/16) … 1 (f/1.4)
  horizon: true,
  skeleton: false,
  scores: true,
  sound: true,
  haptics: true,
  mirrorFront: true,
  flash: 'off',              // off | on | auto
  timer: 0,                  // 0 | 3 | 10
  filterStrength: 1,         // 0 … 1.5
  aspect: '4:3',             // full | 4:3 | 16:9
  deviceName: 'iPhone 18 Pro', // printed on the Specs frame
  aiStyle: 'standard',       // ✦ Find the shot style (see AI_STYLES)
  frame: 'none',             // default frame style in the editor
  exposure: 0,
  filter: 'natural',
  rate: 'auto',
  direction: 'camera',       // camera | subject — how MOVE/TILT directions are phrased
  autoThreshold: AUTO_CAPTURE.thresholds.overall,
  holdMs: AUTO_CAPTURE.holdMs,
  facing: 'environment',
};
