/**
 * Central, overridable configuration for Smart Camera.
 * Nothing in the analysis layers hardcodes thresholds: every weight, target and
 * timing lives here and can be overridden at runtime via Settings.
 */
export const MODELS = {
  // Swap any entry to use a different on-device model. Paths are relative to the app root.
  pose: { path: 'models/pose_landmarker_lite.task', numPoses: 4, minDetection: 0.5, minTracking: 0.5, minPresence: 0.5 },
  face: { path: 'models/blaze_face_short_range.tflite', minDetection: 0.5 },
  // int8 models run on the CPU (XNNPACK) delegate: they are small, run rarely and the GPU delegate rejects int8 output tensors.
  objects: { path: 'models/efficientdet_lite0.tflite', maxResults: 6, scoreThreshold: 0.45, delegate: 'CPU' },
  scene: { path: 'models/efficientnet_lite0.tflite', maxResults: 5, scoreThreshold: 0.1, delegate: 'CPU' },
  runtime: {
    wasmLoaderPath: 'vendor/mediapipe/tasks-vision/wasm/vision_wasm_internal.js',
    wasmBinaryPath: 'vendor/mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm',
    bundle: '../../vendor/mediapipe/tasks-vision/vision_bundle.mjs',
    delegate: 'GPU',   // default for models that do not specify one (pose, face)
  },
};

/** Scheduling (frames between runs) per analysis stage, by performance tier. */
export const SCHEDULE = {
  high:     { pose: 1, face: 2, lighting: 2, objects: 20, scene: 45, maxFps: 30 },
  balanced: { pose: 2, face: 3, lighting: 3, objects: 30, scene: 60, maxFps: 24 },
  low:      { pose: 3, face: 5, lighting: 4, objects: 60, scene: 120, maxFps: 15 },
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
  levelToleranceDeg: 1.5,
  hysteresisDeg: 0.8,
};

/** Overall score blend for Smart Pose. */
export const OVERALL = {
  weights: { pose: 0.35, framing: 0.3, lighting: 0.15, stability: 0.2 },
};

/** Automatic capture gate. */
export const AUTO_CAPTURE = {
  thresholds: { overall: 82, pose: 75, framing: 72, stability: 78, lighting: 40 },
  holdMs: 1000,          // conditions must hold this long before countdown
  countdownMs: 900,      // "Perfect" countdown length
  cooldownMs: 3500,      // after a capture before another auto capture may arm
  cancelMovement: 0.09,  // normalised landmark displacement that cancels the countdown
  requirePoseChange: 0.12, // subject must change pose this much before re-capturing
  groupSettleMs: 1400,   // extra hold when more than one person is in frame
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

export const FILTERS = [
  { id: 'natural', name: 'Natural', css: 'none', adj: {} },
  { id: 'warm', name: 'Warm', css: 'sepia(0.18) saturate(1.15) brightness(1.03)', adj: { temperature: 18, saturation: 1.12, brightness: 1.03 } },
  { id: 'cool', name: 'Cool', css: 'saturate(1.05) hue-rotate(-8deg) brightness(1.02)', adj: { temperature: -18, saturation: 1.05, brightness: 1.02 } },
  { id: 'cinematic', name: 'Cinematic', css: 'contrast(1.15) saturate(0.85) sepia(0.12)', adj: { contrast: 1.15, saturation: 0.85, temperature: 8, vignette: 0.35 } },
  { id: 'vibrant', name: 'Vibrant', css: 'saturate(1.45) contrast(1.08)', adj: { saturation: 1.45, contrast: 1.08 } },
  { id: 'bw', name: 'B&W', css: 'grayscale(1) contrast(1.12)', adj: { saturation: 0, contrast: 1.12 } },
  { id: 'soft', name: 'Soft', css: 'contrast(0.9) brightness(1.06) saturate(0.95)', adj: { contrast: 0.9, brightness: 1.06, saturation: 0.95 } },
  { id: 'contrast', name: 'High Contrast', css: 'contrast(1.35) saturate(1.1)', adj: { contrast: 1.35, saturation: 1.1 } },
  { id: 'golden', name: 'Golden Hour', css: 'sepia(0.3) saturate(1.3) brightness(1.04) contrast(1.05)', adj: { temperature: 30, saturation: 1.3, brightness: 1.04, contrast: 1.05, vignette: 0.2 } },
  { id: 'night', name: 'Night', css: 'brightness(1.15) contrast(1.1) saturate(0.9) hue-rotate(-6deg)', adj: { brightness: 1.15, contrast: 1.1, saturation: 0.9, temperature: -10, shadowLift: 0.12 } },
];

export const SCENES = [
  'portrait', 'group', 'landscape', 'architecture', 'food', 'pet', 'vehicle', 'sunset',
  'night', 'product', 'street', 'beach', 'indoor', 'outdoor',
];

export const DEFAULT_SETTINGS = {
  mode: 'smart',             // photo | smart | pose
  aiEnabled: true,
  grid: false,
  horizon: true,
  skeleton: false,
  scores: true,
  sound: true,
  haptics: true,
  mirrorFront: true,
  flash: 'off',              // off | on | auto
  timer: 0,                  // 0 | 3 | 10
  exposure: 0,
  filter: 'natural',
  rate: 'auto',
  direction: 'camera',       // camera | subject — how MOVE/TILT directions are phrased
  autoThreshold: AUTO_CAPTURE.thresholds.overall,
  holdMs: AUTO_CAPTURE.holdMs,
  facing: 'environment',
};
