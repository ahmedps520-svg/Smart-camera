# Smart Camera

An on-device AI photography assistant, built as an installable web app (PWA) and hosted on GitHub Pages.
Point your phone at a scene; local vision models understand it, the composition engine works out the ideal framing, the reasoning layer tells you what to change, and Smart Pose takes the photo by itself when the pose is strong and stable.

**Everything runs in the browser, on the device.** No camera frame, pose, photo or personal data ever leaves the phone. There is no network code in the app: the only fetches are the app's own static files, which the service worker caches so the whole thing works in airplane mode.

> This repository was asked to be a website rather than a native Swift app. The original brief (native SwiftUI / Core ML / AVFoundation) is implemented here with the web equivalents: MediaPipe Tasks (WASM + WebGL) for Vision/Core ML, `getUserMedia` for AVFoundation, Canvas/CSS filters for Core Image, DeviceMotion for Core Motion and IndexedDB + the share sheet for PhotoKit. Browser limitations are listed honestly at the end.

## What it does

| Area | Implementation |
| --- | --- |
| Live camera | Full-screen GPU (WebGL) preview, one-tap **Selfie** button that works in every mode, photo shape (full screen / 4:3 / 16:9), rear/front switch, physical lens picker, hardware zoom where the browser exposes it plus digital zoom, pinch / slider / preset chips, torch, exposure compensation, tap to focus, timer, flash modes |
| Layer 1: real-time vision | MediaPipe Pose Landmarker (up to 4 people), BlazeFace face detector, EfficientDet-Lite0 object detector, EfficientNet-Lite0 scene classifier, pixel statistics for lighting. Adaptive schedule with frame skipping; expensive models run only every few seconds |
| Layer 2: photography reasoning | Rules engine that consumes structured scene data (never frames) and returns a validated, structured recommendation. Debounced with hysteresis so guidance never flickers. Pluggable: a local LLM adapter can replace it and goes through the same strict validator |
| Smart Photo mode | Deliberately minimal: a yellow rounded ring follows the subject (person, group, or the main object such as a pet or plate) with one small instruction beside it (Move left/right, Tilt up/down, Move closer, Step back, Level the phone, Zoom 2×, ✓ Perfect). A wider dead zone and a 1.6 s hold keep it calm, the instruction freezes while the phone is moving, and the subject is kept through brief detection dropouts so it is not lost while you reframe |
| Smart Pose mode | Continuously scored Pose / Framing / Lighting / Stability / Overall. When the overall score passes the threshold and no score is below its floor, a short hold, a "Perfect" countdown, then auto capture. Brief dips are tolerated; real movement (measured in torso lengths) cancels. Scores that are blocking the capture turn red and are named under the guide. The same pose is re-shot only after it changes or 8 s pass. Works with the front camera for hands-free selfies |
| Portrait mode | Live background blur from on-device person segmentation (MediaPipe selfie segmenter) rendered in the GPU shader, with an aperture slider (f/16 to f/1.4). The person mask is saved with the photo so the depth can be changed afterwards in the editor. Blur only switches on when a person is found |
| Hands-free capture | **Raise a hand** above your head for half a second → 3 s timer → photo. **Smile shutter** (optional) → photo the moment you smile. Both run in every AI mode |
| Blink guard | Face-mesh blendshapes (on-device) give eyes-open scores for everyone in frame; Smart Pose never arms on closed eyes and holds the shutter up to 0.9 s for a blink to finish |
| Burst + Best Shot | Press and hold the shutter: up to 30 frames at ~8/s; each is scored for sharpness (variance of the Laplacian), eyes open and framing, and only the best is kept |
| Pro overlays | Live luminance histogram (clipping in red), highlight-clipping stripes, rule-of-thirds / golden-ratio / centre-cross grids |
| Composition engine | Rule of thirds with lead room, centre, symmetry (mirror score), horizon placement (estimated horizon row), group framing, negative space for vehicles, headroom, edge margins, subject size, clutter |
| Dynamic composition box | Smoothed (One Euro filter) "SUBJECT HERE" box that tracks the subject and turns green with PERFECT when aligned |
| Zoom intelligence | Recommends the lens/zoom that puts the subject at the composition's target size, preferring optical presets, with temporal hysteresis |
| Lighting analysis | Exposure, highlight/shadow clipping, contrast, backlighting (subject vs background), colour cast, noise proxy, advice text |
| Filters | Natural, Warm, Cool, Cinematic, Vibrant, B&W, Soft, High Contrast, Golden Hour, Night, with a 0–150 % strength slider. One colour pipeline (temperature, tint, contrast, S-curve, saturation, split toning, fade, shadow lift, vignette, grain) runs as a WebGL shader for the live preview and full-resolution export, with an identical CPU path. What you see is what you save. Originals are stored untouched; the look is rendered on review and export. A look is recommended from the scene and light |
| Motion | DeviceMotion-based roll, horizon guide with LEVEL readout, motion stability score. Works with both the iOS and Android gravity sign conventions; hidden when the phone points straight up or down |
| Scene understanding | portrait, group, landscape, architecture, food, pet, vehicle, sunset, night, product, street, beach, indoor, outdoor — sticky classification that influences composition and filters |
| Multi-person | Tracks everyone, checks who is cut off, spacing, balance, face visibility; no auto capture until the group is still |
| Library & editor | Full-quality originals in IndexedDB. The thumbnail opens the newest photo; swipe left/right to browse, swipe down to return to the camera, *All* for the grid. **Edit** tab: one-tap Auto-enhance (exposure, contrast, white balance, colour from the photo's histogram) and sliders for Light, Contrast, Warmth, Colour, Vignette and portrait Depth. Edits and looks are non-destructive and remembered per photo. Favourite, delete (from the app only), share / download. Never touches the user's own Photos library |
| Performance | WebGL (GPU) delegate for pose and face, XNNPACK (CPU) for the rare int8 models, `requestVideoFrameCallback`, frame skipping, low-res pixel sampling, reused buffers |
| Thermal management | The web has no thermal API, so a software governor watches inference latency and dropped frames and steps the analysis tier down (fewer model runs, lower analysis resolution) and back up. The preview is never throttled. Battery-low lowers the tier where the Battery API exists |
| Privacy | No uploads, no analytics, no face recognition, no biometric storage, analysis data discarded every frame. See About & privacy in the app |

## Try it

Live at **https://ahmedps520-svg.github.io/Smart-camera/**. GitHub Pages serves the `gh-pages` branch; the workflow in `.github/workflows/pages.yml` runs the unit tests on every push to `main` and, if they pass, publishes `main` to `gh-pages`.

Locally:

```bash
npx http-server -p 8080 -c-1 .
# open http://localhost:8080 (localhost counts as a secure context, so the camera works)
```

On iPhone: open the Pages URL in Safari, tap Share → **Add to Home Screen**. The app then launches full screen, keeps working offline, and asks for camera and motion permission on the first tap. New versions load automatically the next time the app is opened (the service worker fetches app files network-first and reloads once when an update takes over).

## Modes

* **PHOTO** – plain camera, no analysis running (grid and horizon guide still available).
* **SMART** (Smart Photo) – a yellow ring around the subject and one small instruction; you press the shutter.
* **POSE** (Smart Pose) – live guidance plus automatic capture when the pose is strong and stable, with the blink guard.
* **PORTRAIT** – live background blur behind people, adjustable aperture, depth editable after capture.

Guidance directions describe the **camera** by default: "Move right" means pan or step right, which slides the subject left in the frame. If you prefer "move right" to mean "the subject should go right", change *Directions* in the control panel.

**Selfie** (top bar) switches to the front camera in any mode. Guidance is phrased for holding the phone at arm's length ("Raise the phone", "Bring the phone closer"), selfies are framed centred with the eyes on the upper third, and Smart Pose will take the selfie for you.

All analysis runs on exactly what the viewfinder shows: detections are transformed into view coordinates (`js/vision/ViewTransform.js`), and the capture is cropped to the same area, so the composition box, the guidance and the saved photo always agree. *Photo shape* in the control panel trades full-screen framing for the sensor's native 4:3 (more pixels).

## Architecture

```
js/
├── main.js                     view model: wires everything together
├── config/defaults.js          every threshold, weight, target, schedule and model path
├── camera/   CameraController  getUserMedia, zoom (hardware + digital), torch, exposure, focus, capture
│             LensModel         which presets the device really supports
├── motion/   MotionSensor      roll / pitch / level / stability from DeviceMotion
├── render/   LookRenderer      GPU/CPU colour + depth pipeline: preview, viewer, thumbnails, export
│             AutoEnhance       one-tap enhance from the photo's histogram
├── vision/   MediaPipeBackend  pose, face, objects, scene — swap for any backend with the same 4 methods
│             VisionEngine      adaptive per-stage schedule, isolation of failing stages
│             FrameSampler      small ImageData of the visible area for pixel statistics
│             ViewTransform     raw frame → view coordinates
│   analysis/ Expressions       smile / eyes-open per face (blink guard, smile shutter)
│             PerformanceGovernor  software thermal / performance tiers
├── analysis/ SubjectTracker    people + faces → tracked subjects, velocity, group box
│             PoseScorer        configurable pose quality score
│             CompositionEngine composition choice + framing score + target box
│             LightingAnalyzer  exposure / clipping / backlight / cast / noise
│             ZoomAdvisor       lens + zoom recommendation
│             SceneClassifier   labels + objects + people + light → scene (sticky)
│             FilterRecommender scene + light → look
│             GroupAnalyzer     multi-person checks
├── reasoning/ PhotographyReasoner  layer 2 rules engine (replaceable)
│              RecommendationValidator  strict schema; nothing unvalidated reaches the camera
│              Debouncer        message debouncing + Schmitt-trigger hysteresis
├── capture/  AutoCaptureController  MONITORING → HOLDING → COUNTDOWN → CAPTURE → COOLDOWN
│             PhotoProcessor    post-capture analysis and thumbnail
│             Triggers          raise-hand and smile triggers
│             BurstSelector     best-shot scoring for bursts
├── library/  PhotoLibrary      IndexedDB store + share/download
├── settings/ Settings          persisted user settings
└── ui/       Overlay, Controls, ReviewView, LibraryView, Haptics, Sounds, Toast
models/                         on-device model files (swap paths in config/defaults.js)
vendor/mediapipe/tasks-vision/  MediaPipe Tasks runtime (JS + WASM), served from this origin
sw.js                           precaches app, runtime and models for offline use
manifest.webmanifest, icons/    PWA manifest, 192/512 any + maskable icons, Apple touch icon, SVG, favicon
tests/                          node --test unit tests for all logic modules + MANUAL_TEST_PLAN.md
```

Data flow per analysed frame:

```
video frame ─▶ VisionEngine (pose · face · objects · scene · pixels)
           ─▶ SubjectTracker ─▶ PoseScorer / CompositionEngine / LightingAnalyzer / GroupAnalyzer / SceneClassifier / ZoomAdvisor
           ─▶ structured SceneState  { scene, tracked, composition, pose, lighting, motion, zoom, group, scores }
           ─▶ PhotographyReasoner ─▶ RecommendationValidator ─▶ Debouncer
           ─▶ { recommendation, confidence, zoom, composition, reason, captureReady }
           ─▶ UI (guide pill, composition box, zoom chips) and AutoCaptureController
```

### Swapping models and the reasoner

* Model paths, delegates and thresholds live in `js/config/defaults.js` → `MODELS`. Drop a different `.task` / `.tflite` into `models/` and point the config at it; add it to the precache list in `sw.js`.
* Any backend that implements `detectPoses`, `detectFaces`, `detectObjects`, `classifyScene` can replace `MediaPipeBackend`.
* Any object with `reason(state) → candidate` can be passed to `new PhotographyReasoner(myReasoner)`. Output always passes through `validateRecommendation`, which rejects unknown recommendation codes, out-of-range confidence, zoom factors the device does not offer, and non-boolean `captureReady`. A local LLM (for example a small model running through WebGPU) would be given the same structured `SceneState` as text and asked for JSON; it is never given frames and it cannot bypass the validator. No LLM is bundled: at the moment the rules engine is faster, explainable and good enough, and shipping a multi-hundred-megabyte model to a GitHub Pages site is not worth it.

### Scoring configuration

`POSE_SCORING.weights`, `COMPOSITION`, `OVERALL.weights`, `AUTO_CAPTURE.thresholds`, `GUIDANCE` (hysteresis), `ZOOM`, `LIGHTING` and `SCHEDULE` are all plain objects in `js/config/defaults.js`. The control panel exposes the auto-capture threshold, hold time, analysis rate and direction convention at runtime.

## Tests

```bash
npm test          # node --test tests/*.test.js — 58 unit tests over the pure logic modules
```

Browser verification during development used headless Chromium with a fake camera fed by real test images (person, portrait, food, animals): models load from the vendored files, a person is detected and tracked, guidance and the composition box appear, the scene classifier maps labels (cheeseburger → food, cats/dogs → pet, seashore → beach), the shutter saves a full-resolution JPEG to the library with post-capture analysis, and Smart Pose auto-captures after the hold window and countdown.

`tests/MANUAL_TEST_PLAN.md` lists the on-device scenarios from the brief (no person, one, many, moving, poor light, backlight, landscape, architecture, objects, zoom and lens changes, rotation, permission denial, offline, low battery, thermal throttling, iPhone, iPad) with expected behaviour.

## Browser limitations (read this)

The brief asked for native capabilities; these are the places where the web platform cannot fully deliver them.

* **Photos library** – web pages cannot write to the iOS Photos library directly. Captures are stored inside the app (IndexedDB) and *Save / Share* opens the system share sheet, where **Save Image** puts the original into Photos. There is no "Smart Camera" album API on the web.
* **Capture quality** – Safari has no `ImageCapture.takePhoto`, so a still is the current video frame at the stream's full resolution (the app requests up to 4096×3072; iPhones typically deliver 1920×1080 to 3840×2160 for video tracks). That is lower than the native 48 MP photo pipeline and lacks Deep Fusion / HDR merging. Chrome on Android uses the real photo pipeline where available.
* **Lenses** – the browser exposes cameras by label and, on recent Safari/Chrome, a `zoom` range; focal lengths are not exposed. 0.5× is only offered when an ultra-wide device is listed, and 2×/3×/5× only when the hardware zoom range reaches them. Switching to another physical camera restarts the stream.
* **Flash** – torch mode only, where the browser supports the `torch` constraint (Chrome; Safari support varies). Not a true xenon-style flash.
* **Exposure / focus** – only where the browser exposes `exposureCompensation` / `pointsOfInterest`; otherwise those controls report that they are unavailable.
* **Haptics** – iOS Safari has no vibration API; sound and animation stand in. Android uses the Vibration API.
* **Thermal state** – no web API; the governor infers load from inference latency and dropped frames.
* **Performance** – pose + face on a modern iPhone's GPU run at roughly 15–30 analysed frames per second; it is not Neural Engine speed. The governor backs off automatically.
* **EXIF** – captures are JPEGs without EXIF metadata (no location is ever recorded, by design).

## Privacy

No cloud, no analytics, no accounts, no face recognition, no biometric data. Pose landmarks exist only for the current frame and are discarded. Photos stay on the device until you share them. Delete a capture from the app's library at any time; the app never deletes anything outside its own store.

## Licence

MIT for this project. MediaPipe Tasks runtime and models are Apache-2.0 (see `vendor/mediapipe/tasks-vision/LICENSE`).
